// apple-fm-helper — the only part of apple-fm that touches Apple's native
// `FoundationModels` framework. Node can't call it directly, so the CLI/library
// shells out to this tiny Swift program (see ../src/helper.ts) and exchanges
// line-delimited JSON (NDJSON).
//
// Protocol:
//   apple-fm-helper --probe
//       → one JSON line with on-device status and its model entry.
//   apple-fm-helper --generate (or --tag-content for JSON topic tags)
//       reads one request object on stdin:
//         {"system"?,"prompt"?,"messages"?:[{"role","content"}],
//          "schema"?,"options"?:{"temperature"?,"maxTokens"?},"stream"?}
//       writes NDJSON on stdout:
//         {"type":"delta","text":"…"}   (zero or more, only when "stream":true)
//         {"type":"result","content":"…"}   (exactly one on success)
//         {"type":"error","code":"…","message":"…"}   (on failure; exit != 0)
//
// Requires macOS 26+ on Apple Silicon with Apple Intelligence (FoundationModels).
// Build with scripts/build-apple-fm-helper.sh; point apple-fm at the binary with
// APPLE_FM_BIN (or build it to ./bin/apple-fm-helper).
import Foundation
import FoundationModels
#if APPLE_FM_IMAGES
import ImageIO
#endif

// MARK: - Wire types

struct WireMessage: Decodable {
    let role: String
    let content: String
}

enum WireSampling: String, Decodable {
    case greedy
}

struct WireOptions: Decodable {
    let sampling: WireSampling?
    let temperature: Double?
    let maxTokens: Int?
}

struct GenerateRequest: Decodable {
    let imagePath: String?
    let imagePaths: [String]?
    let system: String?
    let prompt: String?
    let messages: [WireMessage]?
    // Guided-generation JSON Schema. When present, translated at runtime to a
    // native `GenerationSchema` (see `compileSchema`) so the framework guarantees
    // the output conforms — see docs/6-guided-generation.md.
    let schema: JSONValue?
    let options: WireOptions?
    let stream: Bool?
}

/// A minimal decoder for arbitrary JSON, used to carry the optional `schema`
/// through verbatim so it can be re-rendered into the prompt.
indirect enum JSONValue: Decodable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let b = try? container.decode(Bool.self) {
            self = .bool(b)
        } else if let n = try? container.decode(Double.self) {
            self = .number(n)
        } else if let s = try? container.decode(String.self) {
            self = .string(s)
        } else if let a = try? container.decode([JSONValue].self) {
            self = .array(a)
        } else if let o = try? container.decode([String: JSONValue].self) {
            self = .object(o)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "unsupported JSON")
        }
    }

    var jsonString: String? {
        switch self {
        case .null: return "null"
        case .bool(let b): return b ? "true" : "false"
        case .number(let n):
            return n == n.rounded() ? String(Int(n)) : String(n)
        case .string(let s): return encodeString(s)
        case .array(let a): return "[" + a.compactMap { $0.jsonString }.joined(separator: ",") + "]"
        case .object(let o):
            return "{" + o.map { "\(encodeString($0.key)):\($0.value.jsonString ?? "null")" }
                .joined(separator: ",") + "}"
        }
    }
}

// MARK: - Output

private func emit(_ json: String) {
    FileHandle.standardOutput.write(Data((json + "\n").utf8))
}

// Events carry an optional `id` so the persistent `--session` mode can correlate
// each event with the command that produced it; `--probe`/`--generate` omit it.
private func idField(_ id: String?) -> String {
    guard let id else { return "" }
    return ",\"id\":\(encodeString(id))"
}

private func emitResult(_ content: String, id: String? = nil) {
    emit("{\"type\":\"result\"\(idField(id)),\"content\":\(encodeString(content))}")
}

private func emitDelta(_ text: String, id: String? = nil) {
    emit("{\"type\":\"delta\"\(idField(id)),\"text\":\(encodeString(text))}")
}

private func emitReady(_ id: String?) {
    let capability = modelContextSize().map { ",\"contextSize\":\($0)" } ?? ""
    emit("{\"type\":\"ready\"\(idField(id))\(capability),\"transcriptPersistence\":true}")
}

/// A full partial value for guided streaming (replace semantics, not a suffix).
private func emitSnapshot(_ content: String, id: String? = nil) {
    emit("{\"type\":\"snapshot\"\(idField(id)),\"content\":\(encodeString(content))}")
}

/// A tool the model invoked mid-turn. `argumentsJSON` is embedded as raw JSON (the
/// model's generated arguments), not a string. `internal` so `ToolBridge` (in
/// Tools.swift) can call it. See docs/9-tool-calling.md.
func emitToolCall(name: String, callId: String, argumentsJSON: String, id: String?) {
    emit("{\"type\":\"tool_call\"\(idField(id)),\"callId\":\(encodeString(callId)),\"name\":\(encodeString(name)),\"arguments\":\(argumentsJSON)}")
}

/// Emit an error event without exiting (used per-turn in `--session`). `internal` so
/// `buildTools` (in Tools.swift) can report an unsupported tool schema.
func emitError(_ code: String, _ message: String, id: String?) {
    emit("{\"type\":\"error\"\(idField(id)),\"code\":\(encodeString(code)),\"message\":\(encodeString(message))}")
}

/// Emit an error event and exit non-zero (one-shot `--probe`/`--generate`).
private func failEvent(_ code: String, _ message: String) -> Never {
    emitError(code, message, id: nil)
    exit(1)
}

/// JSON-encode a string (with surrounding quotes) using Foundation's encoder so
/// escaping is always correct.
private func encodeString(_ value: String) -> String {
    let data = try? JSONEncoder().encode(value)
    return data.flatMap { String(data: $0, encoding: .utf8) } ?? "\"\""
}

// MARK: - Probe

private func modelContextSize() -> Int? {
    if #available(macOS 26.4, *) { return SystemLanguageModel.default.contextSize }
    return nil
}

private func probe() -> Never {
    let reason: String?
    switch SystemLanguageModel.default.availability {
    case .available: reason = nil
    case .unavailable(let unavailable): reason = reasonString(unavailable)
    @unknown default: reason = "unknown"
    }

    var status: [String: Any] = ["available": reason == nil]
    status["reason"] = reason
    var result = status
    var model = status
    model["id"] = "on-device"
    result["models"] = [model]
    result["contextSize"] = modelContextSize()
    do {
        let data = try JSONSerialization.data(withJSONObject: result, options: .sortedKeys)
        emit(String(decoding: data, as: UTF8.self))
    } catch {
        failEvent("probeFailed", "could not encode model availability")
    }
    exit(0)
}

private func reasonString(_ reason: SystemLanguageModel.Availability.UnavailableReason) -> String {
    switch reason {
    case .deviceNotEligible: return "deviceNotEligible"
    case .appleIntelligenceNotEnabled: return "appleIntelligenceNotEnabled"
    case .modelNotReady: return "modelNotReady"
    @unknown default: return "unknown"
    }
}

// MARK: - Generate

/// The session instructions — just the caller's system prompt. Structured output
/// is handled natively via `respond(to:schema:)` (see `generate`), not by injecting
/// the schema into the prompt.
private func instructions(for request: GenerateRequest) -> String? {
    guard let system = request.system, !system.isEmpty else { return nil }
    return system
}

// Guided-generation schema translation lives in GuidedGeneration.swift
// (`compileSchema` / `UnsupportedSchema`), compiled into the same binary.

/// Build the single user prompt from either `prompt` or a `messages` transcript.
/// The `messages` labeling below must mirror the Node side's canonical format
/// (`src/protocol.ts` `flattenMessages`: `User:`/`Assistant:`, blank-line
/// separated) so replayed conversations behave identically on both sides.
private func userPrompt(for request: GenerateRequest) -> String {
    if let prompt = request.prompt { return prompt }
    if let messages = request.messages {
        return messages.map { "\($0.role == "assistant" ? "Assistant" : "User"): \($0.content)" }
            .joined(separator: "\n\n")
    }
    return ""
}

private func countPromptTokens(_ request: GenerateRequest) async -> Never {
    guard #available(macOS 26.4, *) else {
        failEvent("unsupported", "native token counting requires macOS 26.4 or later")
    }
    let model = SystemLanguageModel.default
    guard case .available = model.availability else {
        failEvent("unavailable", "Apple Foundation Models unavailable")
    }
    do {
        let count = try await model.tokenCount(for: userPrompt(for: request))
        emitResult(String(count))
    } catch {
        let f = failure(for: error)
        failEvent(f.code, f.message)
    }
    exit(0)
}

private func generationOptions(_ options: WireOptions?) -> GenerationOptions {
    guard let options else { return GenerationOptions() }
    return GenerationOptions(
        sampling: options.sampling == .greedy ? .greedy : nil,
        temperature: options.temperature,
        maximumResponseTokens: options.maxTokens)
}

@Generable
private struct ContentTags {
    @Guide(description: "Short tags that categorize the input text.")
    let tags: [String]
}

private func tagContent(_ request: GenerateRequest) async -> Never {
    guard request.schema == nil, request.stream != true else {
        failEvent("badRequest", "content-tagging cannot be combined with streaming or a custom schema")
    }
    let model = SystemLanguageModel(useCase: .contentTagging)
    guard case .available = model.availability else {
        failEvent("unavailable", "Apple Foundation Models content tagging unavailable")
    }
    let session = LanguageModelSession(
        model: model,
        instructions: instructions(for: request) ?? "Return the most significant topic tags in the input."
    )
    do {
        let response = try await session.respond(
            to: userPrompt(for: request),
            generating: ContentTags.self,
            options: generationOptions(request.options)
        )
        let data = try JSONEncoder().encode(response.content.tags)
        emitResult(String(decoding: data, as: UTF8.self))
    } catch {
        let f = failure(for: error)
        failEvent(f.code, f.message)
    }
    exit(0)
}

private func generateImage(_ request: GenerateRequest) async -> Never {
    #if APPLE_FM_IMAGES
    if #available(macOS 27.0, *) {
        let paths = request.imagePaths ?? request.imagePath.map { [$0] } ?? []
        guard !paths.isEmpty, paths.allSatisfy({ !$0.isEmpty }) else {
            failEvent("badRequest", "expected at least one local image path")
        }
        let urls = paths.map { path in
            let url = URL(fileURLWithPath: path)
            guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
                  CGImageSourceGetCount(source) > 0 else {
                failEvent("invalidImage", "could not read an image at \(path)")
            }
            return url
        }
        let prompt = Prompt {
            userPrompt(for: request)
            for url in urls {
                Attachment(imageURL: url)
            }
        }
        await generate(request, prompt: prompt)
    }
    #endif
    failEvent("unsupported", "image input requires macOS 27 and a helper built with the macOS 27 SDK")
}

private func generate(_ request: GenerateRequest, prompt: Prompt) async -> Never {
    guard case .available = SystemLanguageModel.default.availability else {
        failEvent("unavailable", "Apple Foundation Models unavailable")
    }
    let session = LanguageModelSession(instructions: instructions(for: request))
    let options = generationOptions(request.options)

    // Native guided generation: guaranteed structure, or a clear error. Strict —
    // no prompt-guided fallback (see docs/6-guided-generation.md).
    if let schema = request.schema {
        let compiled: GenerationSchema
        do {
            compiled = try compileSchema(from: schema)
        } catch let error as UnsupportedSchema {
            failEvent("unsupportedSchema", error.message)
        } catch {
            failEvent("unsupportedSchema", "could not build a generation schema: \(String(describing: error))")
        }
        do {
            if request.stream == true {
                // Structured partials are NOT append-only (keys reorder, values
                // grow in place), so each partial is emitted as a full `snapshot`
                // (replace semantics) rather than a `delta` suffix; the final
                // `result` carries the complete JSON. See docs/4-protocol.md.
                var last = ""
                for try await partial in session.streamResponse(to: prompt, schema: compiled, options: options) {
                    last = partial.content.jsonString
                    emitSnapshot(last)
                }
                emitResult(last)
            } else {
                let response = try await session.respond(to: prompt, schema: compiled, options: options)
                emitResult(response.content.jsonString)
            }
            exit(0)
        } catch {
            let f = failure(for: error)
            failEvent(f.code, f.message)
        }
    }

    do {
        if request.stream == true {
            var emitted = ""
            for try await partial in session.streamResponse(to: prompt, options: options) {
                // Partials are cumulative; emit only the newly-appended suffix.
                let full = partial.content
                if full.count > emitted.count {
                    emitDelta(String(full.dropFirst(emitted.count)))
                    emitted = full
                }
            }
            emitResult(emitted)
        } else {
            let response = try await session.respond(to: prompt, options: options)
            emitResult(response.content)
        }
        exit(0)
    } catch {
        let f = failure(for: error)
        failEvent(f.code, f.message)
    }
}

/// Collect an NSError and every error nested under it (`NSUnderlyingErrorKey` plus
/// the `NSMultipleUnderlyingErrorsKey` array), breadth-first, outermost first.
/// Bounded so a pathological cycle can't spin forever.
private func errorChain(_ error: Error) -> [NSError] {
    var collected: [NSError] = []
    var queue: [NSError] = [error as NSError]
    while let next = queue.first, collected.count < 50 {
        queue.removeFirst()
        collected.append(next)
        if let underlying = next.userInfo[NSUnderlyingErrorKey] as? NSError {
            queue.append(underlying)
        }
        if let multiple = next.userInfo[NSMultipleUnderlyingErrorsKey] as? [Error] {
            queue.append(contentsOf: multiple.map { $0 as NSError })
        }
    }
    return collected
}

/// Reduce a thrown error to a wire `(code, message)`. The framework wraps the real
/// cause in nested NSErrors, so: recognize "model still provisioning"
/// (`ModelManagerError` 1008 — which can occur even though `availability` reported
/// `.available`); honor the typed `GenerationError` cases; otherwise collapse the
/// chain to its innermost `domain Code=n` rather than emitting the whole multi-level
/// NSError dump. See docs/4-protocol.md (error codes).
private func failure(for error: Error) -> (code: String, message: String) {
    #if APPLE_FM_IMAGES
    if #available(macOS 27.0, *),
       let modelError = error as? LanguageModelError,
       case .contextSizeExceeded = modelError {
        return ("contextWindowExceeded", "the model's context window was exceeded")
    }
    #endif
    let chain = errorChain(error)
    if chain.contains(where: { $0.domain.contains("ModelManagerError") && $0.code == 1008 }) {
        return ("modelNotReady", "the on-device model is still provisioning; try again shortly")
    }
    if let generation = error as? LanguageModelSession.GenerationError {
        switch generation {
        case .exceededContextWindowSize:
            return ("contextWindowExceeded", "the model's context window was exceeded")
        case .guardrailViolation:
            return ("guardrailViolation", "the request was blocked by the model's safety guardrails")
        default:
            break
        }
    }
    let innermost = chain.last ?? (error as NSError)
    let summary = "\(innermost.domain) Code=\(innermost.code)"
    // A typed-but-unmatched generation error is still a generation-side failure;
    // anything else is a generic inference failure.
    let code = error is LanguageModelSession.GenerationError ? "generationError" : "inferenceFailed"
    return (code, summary)
}

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
            emitResult(response.content, id: command.id)
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

/// Hold one `LanguageModelSession` across many turns (KV-cache reuse). Reads one
/// command per stdin line and exits 0 on EOF. A turn error is reported per-turn and
/// does not end the loop; a `reset` recreates the session with new instructions +
/// seed (+ tools) and acks with `ready`.
///
/// Turns are serial, but the model may call a tool mid-turn — so a turn runs as a
/// detached task while the reader keeps reading, delivering the `tool_result` /
/// `tool_error` lines into the suspended `tool_call` via the `ToolBridge`. The next
/// turn waits on the previous task, so only one turn is ever live. See
/// docs/9-tool-calling.md.
private func runSession() async -> Never {
    guard case .available = SystemLanguageModel.default.availability else {
        failEvent("unavailable", "Apple Foundation Models unavailable")
    }
    let bridge = ToolBridge()
    var session = LanguageModelSession()
    var currentTurn: Task<Void, Never>?
    do {
        for try await line in FileHandle.standardInput.bytes.lines {
            if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
            guard let command = try? JSONDecoder().decode(SessionCommand.self, from: Data(line.utf8)) else {
                emitError("badRequest", "malformed session command", id: nil)
                continue
            }
            switch command.type {
            case "tool_result":
                await bridge.resolve(callId: command.callId ?? "", reply: .result(command.content ?? ""))
            case "tool_error":
                await bridge.resolve(callId: command.callId ?? "", reply: .error(command.message ?? "tool failed"))
            case "cancel":
                // Interrupt the in-flight turn (FR-15). Turns are serial, so the one
                // live task is the target; it ends by emitting its partial `result`.
                currentTurn?.cancel()
            case "export_transcript":
                await currentTurn?.value
                do {
                    let data = try JSONEncoder().encode(session.transcript)
                    emitResult(String(decoding: data, as: UTF8.self), id: command.id)
                } catch {
                    emitError("transcriptError", "could not encode native transcript", id: command.id)
                }
            case "import_transcript":
                await currentTurn?.value
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
                await currentTurn?.value
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
                await currentTurn?.value // no turn should be in flight, but be safe
                session = makeSession(command, bridge: bridge)
                emitReady(command.id)
            default:
                await currentTurn?.value // serialize: one turn at a time
                await bridge.beginTurn(command.id)
                let active = session
                currentTurn = Task { await sessionTurn(active, command) }
            }
        }
        await currentTurn?.value
    } catch {
        failEvent("inferenceFailed", "session input error: \(String(describing: error))")
    }
    exit(0)
}

// MARK: - Entry

private func readRequest() -> GenerateRequest {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard let request = try? JSONDecoder().decode(GenerateRequest.self, from: data) else {
        failEvent("badRequest", "expected a JSON generation request on stdin")
    }
    return request
}

let args = CommandLine.arguments
if args.contains("--probe") {
    probe()
} else if args.contains("--tokens") {
    let request = readRequest()
    Task { await countPromptTokens(request) }
    dispatchMain()
} else if args.contains("--generate") {
    let request = readRequest()
    Task { await generate(request, prompt: Prompt(userPrompt(for: request))) }
    dispatchMain()
} else if args.contains("--generate-image") || args.contains("--generate-images") {
    let request = readRequest()
    Task { await generateImage(request) }
    dispatchMain()
} else if args.contains("--tag-content") {
    let request = readRequest()
    Task { await tagContent(request) }
    dispatchMain()
} else if args.contains("--session") {
    Task { await runSession() }
    dispatchMain()
} else {
    FileHandle.standardError.write(Data("usage: apple-fm-helper --probe | --tokens | --generate | --generate-image | --generate-images | --tag-content | --session\n".utf8))
    exit(64)
}
