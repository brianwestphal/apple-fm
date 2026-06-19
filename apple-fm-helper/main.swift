// apple-fm-helper — the only part of apple-fm that touches Apple's native
// `FoundationModels` framework. Node can't call it directly, so the CLI/library
// shells out to this tiny Swift program (see ../src/helper.ts) and exchanges
// line-delimited JSON (NDJSON).
//
// Protocol:
//   apple-fm-helper --probe
//       → one JSON line: {"available":true}
//                     or {"available":false,"reason":"appleIntelligenceNotEnabled"}
//   apple-fm-helper --generate
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

// MARK: - Wire types

struct WireMessage: Decodable {
    let role: String
    let content: String
}

struct WireOptions: Decodable {
    let temperature: Double?
    let maxTokens: Int?
}

struct GenerateRequest: Decodable {
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
    emit("{\"type\":\"ready\"\(idField(id))}")
}

/// Emit an error event without exiting (used per-turn in `--session`).
private func emitError(_ code: String, _ message: String, id: String?) {
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

private func probe() -> Never {
    switch SystemLanguageModel.default.availability {
    case .available:
        emit("{\"available\":true}")
    case .unavailable(let reason):
        emit("{\"available\":false,\"reason\":\(encodeString(reasonString(reason)))}")
    @unknown default:
        emit("{\"available\":false,\"reason\":\"unknown\"}")
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

// MARK: - Guided generation

/// Thrown when a request's JSON Schema uses a construct the native
/// `DynamicGenerationSchema` can't express. Surfaced to the caller as the
/// `unsupportedSchema` error code — strict, no prompt-guided fallback (see
/// docs/6-guided-generation.md).
private struct UnsupportedSchema: Error { let message: String }

private func stringField(_ object: [String: JSONValue], _ key: String) -> String? {
    if case .string(let value)? = object[key] { return value }
    return nil
}

private func intField(_ object: [String: JSONValue], _ key: String) -> Int? {
    if case .number(let value)? = object[key] { return Int(value) }
    return nil
}

private func doubleField(_ object: [String: JSONValue], _ key: String) -> Double? {
    if case .number(let value)? = object[key] { return value }
    return nil
}

/// `minimum` / `maximum` → integer range guides (a documented range, or an open
/// bound). A `minimum > maximum` schema is rejected so the `ClosedRange` is valid.
private func intGuides(_ object: [String: JSONValue]) throws -> [GenerationGuide<Int>] {
    let lo = intField(object, "minimum")
    let hi = intField(object, "maximum")
    if let lo, let hi {
        guard lo <= hi else { throw UnsupportedSchema(message: "minimum (\(lo)) is greater than maximum (\(hi))") }
        return [.range(lo...hi)]
    }
    if let lo { return [.minimum(lo)] }
    if let hi { return [.maximum(hi)] }
    return []
}

/// `minimum` / `maximum` → floating-point range guides (see `intGuides`).
private func doubleGuides(_ object: [String: JSONValue]) throws -> [GenerationGuide<Double>] {
    let lo = doubleField(object, "minimum")
    let hi = doubleField(object, "maximum")
    if let lo, let hi {
        guard lo <= hi else { throw UnsupportedSchema(message: "minimum (\(lo)) is greater than maximum (\(hi))") }
        return [.range(lo...hi)]
    }
    if let lo { return [.minimum(lo)] }
    if let hi { return [.maximum(hi)] }
    return []
}

/// Translate one JSON Schema node into a `DynamicGenerationSchema`. Strict: any
/// construct outside the documented subset throws `UnsupportedSchema`. `name` is
/// made unique across the tree by `counter` (object / enum nodes are named).
private func dynamicSchema(_ node: JSONValue, name: String, counter: inout Int) throws -> DynamicGenerationSchema {
    guard case .object(let object) = node else {
        throw UnsupportedSchema(message: "schema node must be a JSON object")
    }
    let description = stringField(object, "description")
    guard let type = stringField(object, "type") else {
        throw UnsupportedSchema(message: "schema node is missing a string \"type\" (oneOf / anyOf / allOf / $ref are not supported)")
    }
    switch type {
    case "object":
        guard case .object(let properties)? = object["properties"] else {
            throw UnsupportedSchema(message: "object schema is missing \"properties\"")
        }
        var required: Set<String> = []
        if case .array(let names)? = object["required"] {
            for entry in names { if case .string(let key) = entry { required.insert(key) } }
        }
        var built: [DynamicGenerationSchema.Property] = []
        for (key, child) in properties {
            counter += 1
            let childSchema = try dynamicSchema(child, name: "\(name).\(key).\(counter)", counter: &counter)
            let childDescription: String? = {
                if case .object(let childObject) = child { return stringField(childObject, "description") }
                return nil
            }()
            built.append(.init(name: key, description: childDescription, schema: childSchema, isOptional: !required.contains(key)))
        }
        return DynamicGenerationSchema(name: name, description: description, properties: built)
    case "string":
        if case .array(let choices)? = object["enum"] {
            var values: [String] = []
            for choice in choices {
                guard case .string(let value) = choice else {
                    throw UnsupportedSchema(message: "only string enum values are supported")
                }
                values.append(value)
            }
            return DynamicGenerationSchema(name: name, description: description, anyOf: values)
        }
        // String value constraints (pattern / minLength / maxLength / format) are
        // not enforced: the on-device model's constrained decoding rejects a
        // `GenerationGuide.pattern` regex (it errors at generation time), so a
        // `pattern` guide would break any schema that uses one. Structure is still
        // guaranteed; the constraint is documented as best-effort. See docs/6.
        return DynamicGenerationSchema(type: String.self)
    case "integer":
        return DynamicGenerationSchema(type: Int.self, guides: try intGuides(object))
    case "number":
        return DynamicGenerationSchema(type: Double.self, guides: try doubleGuides(object))
    case "boolean":
        return DynamicGenerationSchema(type: Bool.self)
    case "array":
        guard let items = object["items"] else {
            throw UnsupportedSchema(message: "array schema is missing \"items\"")
        }
        counter += 1
        let itemSchema = try dynamicSchema(items, name: "\(name).item.\(counter)", counter: &counter)
        return DynamicGenerationSchema(
            arrayOf: itemSchema,
            minimumElements: intField(object, "minItems"),
            maximumElements: intField(object, "maxItems"))
    default:
        throw UnsupportedSchema(message: "unsupported JSON Schema type: \(type)")
    }
}

/// Build a native `GenerationSchema` from the request's JSON Schema. Nested schemas
/// are inlined, so `dependencies` is empty.
private func compileSchema(from schema: JSONValue) throws -> GenerationSchema {
    var counter = 0
    let root = try dynamicSchema(schema, name: "Output", counter: &counter)
    return try GenerationSchema(root: root, dependencies: [])
}

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

private func generationOptions(_ options: WireOptions?) -> GenerationOptions {
    guard let options else { return GenerationOptions() }
    return GenerationOptions(
        temperature: options.temperature,
        maximumResponseTokens: options.maxTokens)
}

private func generate(_ request: GenerateRequest) async -> Never {
    guard case .available = SystemLanguageModel.default.availability else {
        failEvent("unavailable", "Apple Foundation Models unavailable")
    }
    let session = LanguageModelSession(instructions: instructions(for: request))
    let prompt = userPrompt(for: request)
    let options = generationOptions(request.options)

    // Native guided generation: guaranteed structure, or a clear error. Strict —
    // no prompt-guided fallback (see docs/6-guided-generation.md).
    if let schema = request.schema {
        if request.stream == true {
            failEvent("badRequest", "streaming is not supported with a schema (structured streaming is not yet implemented)")
        }
        let compiled: GenerationSchema
        do {
            compiled = try compileSchema(from: schema)
        } catch let error as UnsupportedSchema {
            failEvent("unsupportedSchema", error.message)
        } catch {
            failEvent("unsupportedSchema", "could not build a generation schema: \(String(describing: error))")
        }
        do {
            let response = try await session.respond(to: prompt, schema: compiled, options: options)
            emitResult(response.content.jsonString)
            exit(0)
        } catch let error as LanguageModelSession.GenerationError {
            failEvent(errorCode(error), String(describing: error))
        } catch {
            failEvent("inferenceFailed", String(describing: error))
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
    } catch let error as LanguageModelSession.GenerationError {
        failEvent(errorCode(error), String(describing: error))
    } catch {
        failEvent("inferenceFailed", String(describing: error))
    }
}

private func errorCode(_ error: LanguageModelSession.GenerationError) -> String {
    switch error {
    case .exceededContextWindowSize: return "contextWindowExceeded"
    case .guardrailViolation: return "guardrailViolation"
    default: return "generationError"
    }
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

/// Run one turn against the held session, emitting id-tagged events.
private func sessionTurn(_ session: LanguageModelSession, _ command: SessionCommand) async {
    let prompt = command.prompt ?? ""
    let options = generationOptions(command.options)
    do {
        if command.stream == true {
            var emitted = ""
            for try await partial in session.streamResponse(to: prompt, options: options) {
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
    } catch let error as LanguageModelSession.GenerationError {
        emitError(errorCode(error), String(describing: error), id: command.id)
    } catch {
        emitError("inferenceFailed", String(describing: error), id: command.id)
    }
}

/// Hold one `LanguageModelSession` across many turns (KV-cache reuse). Reads one
/// command per stdin line, serially, and exits 0 on EOF. A turn error is reported
/// per-turn and does not end the loop; a `reset` recreates the session with new
/// instructions + seed and acks with `ready`.
private func runSession() async -> Never {
    guard case .available = SystemLanguageModel.default.availability else {
        failEvent("unavailable", "Apple Foundation Models unavailable")
    }
    var session = LanguageModelSession()
    do {
        for try await line in FileHandle.standardInput.bytes.lines {
            if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
            guard let command = try? JSONDecoder().decode(SessionCommand.self, from: Data(line.utf8)) else {
                emitError("badRequest", "malformed session command", id: nil)
                continue
            }
            if command.type == "reset" {
                session = LanguageModelSession(
                    instructions: sessionInstructions(system: command.system, seed: command.seed))
                emitReady(command.id)
            } else {
                await sessionTurn(session, command)
            }
        }
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
} else if args.contains("--generate") {
    let request = readRequest()
    Task { await generate(request) }
    dispatchMain()
} else if args.contains("--session") {
    Task { await runSession() }
    dispatchMain()
} else {
    FileHandle.standardError.write(Data("usage: apple-fm-helper --probe | --generate | --session\n".utf8))
    exit(64)
}
