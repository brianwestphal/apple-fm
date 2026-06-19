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
    // Guided-generation schema. Captured but, for now, applied as prompt
    // guidance (see `instructions(for:)`). Native `DynamicGenerationSchema`
    // guided generation is the planned enhancement — see docs/3-requirements.md.
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

private func emitResult(_ content: String) {
    emit("{\"type\":\"result\",\"content\":\(encodeString(content))}")
}

private func emitDelta(_ text: String) {
    emit("{\"type\":\"delta\",\"text\":\(encodeString(text))}")
}

private func failEvent(_ code: String, _ message: String) -> Never {
    emit("{\"type\":\"error\",\"code\":\(encodeString(code)),\"message\":\(encodeString(message))}")
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

/// Combine the caller's system prompt with any schema guidance.
private func instructions(for request: GenerateRequest) -> String {
    var parts: [String] = []
    if let system = request.system, !system.isEmpty { parts.append(system) }
    if let schema = request.schema {
        // Prompt-guided structured output. The richer path (native guided
        // generation with a runtime `DynamicGenerationSchema`) is tracked in the
        // requirements doc; until then we instruct the model to match the schema.
        parts.append(
            "Respond with JSON only — no prose, no code fences — matching this JSON Schema:\n"
                + (schema.jsonString ?? "{}"))
    }
    return parts.joined(separator: "\n\n")
}

/// Build the single user prompt from either `prompt` or a `messages` transcript.
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
} else {
    FileHandle.standardError.write(Data("usage: apple-fm-helper --probe | --generate\n".utf8))
    exit(64)
}
