import Foundation
import FoundationModels

// MARK: - Session (persistent live session)

/// One command read on stdin in `--session` mode: either a turn (has `prompt`) or
/// a `reset` (`type == "reset"`). See docs/4-protocol.md / docs/7-live-session.md.
struct SessionCommand: Decodable {
    let type: String?
    let id: String?
    let system: String?
    let seed: [WireMessage]?
    let prompt: String?
    let options: WireOptions?
    let stream: Bool?
    // Tool calling (FR-14): `tools` rides on a `reset` (the framework binds tools at
    // session construction); `callId`/`content`/`message` carry a tool outcome back
    // into a suspended `tool_call`. See docs/9-tool-calling.md.
    let tools: [WireTool]?
    let callId: String?
    let content: String?
    let message: String?
}

/// Compose session instructions from a system prompt plus any seed turns, folded
/// in as a labeled recap so a `reset` preserves recent context without re-running
/// it as live turns. Mirrors `userPrompt` / `flattenMessages` labeling.
private func sessionInstructions(system: String?, seed: [WireMessage]?) -> String? {
    var parts: [String] = []
    if let system, !system.isEmpty { parts.append(system) }
    if let seed, !seed.isEmpty {
        let transcript = seed
            .map { "\($0.role == "assistant" ? "Assistant" : "User"): \($0.content)" }
            .joined(separator: "\n\n")
        parts.append("Conversation so far:\n\(transcript)")
    }
    return parts.isEmpty ? nil : parts.joined(separator: "\n\n")
}

/// Run one turn against the held session, emitting id-tagged events. The turn runs
/// as a cancellable task (see `runSession`): a `cancel` command cancels it, and the
/// turn ends cleanly by emitting a `result` carrying the partial text generated so
/// far — *not* an `error` — so the Node side (which requested the cancel) settles the
/// turn and keeps the partial reply (FR-15; esc-to-interrupt). See docs/4-protocol.md.
private func sessionTurn(_ session: LanguageModelSession, _ command: SessionCommand) async {
    let prompt = command.prompt ?? ""
    let options = generationOptions(command.options)
    var emitted = ""
    do {
        try Task.checkCancellation()
        if command.stream == true {
            for try await partial in session.streamResponse(to: prompt, options: options) {
                // Cooperative cancellation: stop streaming and report the partial.
                if Task.isCancelled { break }
                let full = partial.content
                if full.count > emitted.count {
                    emitDelta(String(full.dropFirst(emitted.count)), id: command.id)
                    emitted = full
                }
            }
            emitResult(emitted, id: command.id)
        } else {
            let response = try await session.respond(to: prompt, options: options)
            emitResult(Task.isCancelled ? emitted : response.content, id: command.id)
        }
    } catch is CancellationError {
        emitResult(emitted, id: command.id)
    } catch {
        // A cancelled stream can surface as a generic framework error rather than a
        // typed CancellationError; treat any error on a cancelled turn as the same
        // clean partial-result interrupt.
        if Task.isCancelled {
            emitResult(emitted, id: command.id)
        } else {
            let f = failure(for: error)
            emitError(f.code, f.message, id: command.id)
        }
    }
}

/// Build the session for a `reset`: with the command's tools when any are offered,
/// otherwise the plain session. Tools are bound at construction (the framework's
/// model), so they ride on `reset`, not each turn.
private func makeSession(_ command: SessionCommand, bridge: ToolBridge) -> LanguageModelSession {
    let instructions = sessionInstructions(system: command.system, seed: command.seed)
    let tools = buildTools(command.tools ?? [], bridge: bridge)
    if tools.isEmpty {
        return LanguageModelSession(instructions: instructions)
    }
    return LanguageModelSession(tools: tools, instructions: instructions)
}

/// Mutates the held model session in command order while the reader routes
/// cancellation and tool replies independently to the active turn.
private func runSessionCommands(
    _ commands: AsyncStream<SessionCommand>, bridge: ToolBridge, turns: SessionTurns
) async {
    var session = LanguageModelSession()
    for await command in commands {
        switch command.type {
        case "export_transcript":
            do {
                let data = try JSONEncoder().encode(session.transcript)
                emitResult(String(decoding: data, as: UTF8.self), id: command.id)
            } catch {
                emitError("transcriptError", "could not encode native transcript", id: command.id)
            }
        case "import_transcript":
            guard let content = command.content,
                  let transcript = try? JSONDecoder().decode(Transcript.self, from: Data(content.utf8))
            else {
                emitError("transcriptError", "invalid or incompatible native transcript", id: command.id)
                continue
            }
            let tools = buildTools(command.tools ?? [], bridge: bridge)
            let expected = Set(transcript.flatMap { entry -> [String] in
                if case .instructions(let instructions) = entry {
                    return instructions.toolDefinitions.map(\.name)
                }
                return []
            })
            guard expected == Set(tools.map(\.name)) else {
                emitError("transcriptError", "enabled tools do not match the native transcript", id: command.id)
                continue
            }
            session = LanguageModelSession(tools: tools, transcript: transcript)
            emitReady(command.id)
        case "count_tokens":
            if #available(macOS 26.4, *) {
                do {
                    let model = SystemLanguageModel.default
                    let history = try await model.tokenCount(for: session.transcript)
                    let prompt: Int
                    if let nextPrompt = command.prompt, !nextPrompt.isEmpty {
                        prompt = try await model.tokenCount(for: nextPrompt)
                    } else {
                        prompt = 0
                    }
                    emitResult(String(history + prompt), id: command.id)
                } catch {
                    let f = failure(for: error)
                    emitError(f.code, f.message, id: command.id)
                }
            } else {
                emitError("unsupported", "native token counting requires macOS 26.4 or later", id: command.id)
            }
        case "reset":
            session = makeSession(command, bridge: bridge)
            emitReady(command.id)
        default:
            let active = session
            let ran = await turns.run(command.id) {
                await bridge.beginTurn(command.id)
                await sessionTurn(active, command)
            }
            if !ran { emitResult("", id: command.id) }
        }
    }
}

/// Read commands until EOF. Turns and session operations stay serial. The
/// reader can still deliver a tool result or cancel while an operation is queued.
func runSession() async -> Never {
    guard case .available = SystemLanguageModel.default.availability else {
        failEvent("unavailable", "Apple Foundation Models unavailable")
    }
    let bridge = ToolBridge { name, callId, argumentsJSON, id in
        emitToolCall(name: name, callId: callId, argumentsJSON: argumentsJSON, id: id)
    }
    let turns = SessionTurns()
    let (commands, input) = AsyncStream<SessionCommand>.makeStream(bufferingPolicy: .bufferingOldest(16))
    let worker = Task { await runSessionCommands(commands, bridge: bridge, turns: turns) }

    func queue(_ command: SessionCommand, turn: Bool = false) async {
        if case .dropped = input.yield(command) {
            if turn { await turns.discardQueued(command.id) }
            emitError("badRequest", "session command queue is full", id: command.id)
        }
    }

    func consume(_ line: Data) async {
        if line.allSatisfy({ $0 == 32 || $0 == 9 || $0 == 13 }) { return }
        guard let command = try? JSONDecoder().decode(SessionCommand.self, from: line) else {
            emitError("badRequest", "malformed session command", id: nil)
            return
        }
        switch command.type {
        case "tool_result":
            await bridge.resolve(callId: command.callId ?? "", reply: .result(command.content ?? ""))
        case "tool_error":
            await bridge.resolve(callId: command.callId ?? "", reply: .error(command.message ?? "tool failed"))
        case "cancel":
            if await turns.cancel(command.id) { await bridge.cancelTurn(command.id) }
        case "export_transcript", "import_transcript", "count_tokens", "reset":
            await queue(command)
        default:
            if await turns.enqueue(command.id) {
                await queue(command, turn: true)
            } else {
                emitError("badRequest", "duplicate pending turn id", id: nil)
            }
        }
    }
    do {
        var line = Data()
        for try await byte in FileHandle.standardInput.bytes {
            if byte == 10 {
                await consume(line)
                line.removeAll(keepingCapacity: true)
            } else {
                guard line.count < maxInputFrameBytes else {
                    failEvent("badRequest", "session command exceeds 4 MiB")
                }
                line.append(byte)
            }
        }
        if !line.isEmpty { await consume(line) }
        input.finish()
        await worker.value
    } catch {
        failEvent("inferenceFailed", "session input error: \(String(describing: error))")
    }
    exit(0)
}
