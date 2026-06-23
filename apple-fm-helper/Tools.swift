// Tool calling (FR-14 / AF-5; see docs/9-tool-calling.md). The on-device model can
// call tools, but apple-fm's tools (read/bash/web) live in the Node layer — typed,
// tested, and (phase 2) permission-checked. So one generic `DynamicTool` represents
// any Node-defined tool: its arguments schema is the caller's JSON Schema compiled to
// a native `GenerationSchema` (reusing the guided-generation translation, FR-8), and
// its `call` round-trips the invocation to Node over NDJSON via the `ToolBridge`.
//
// Part of apple-fm-helper (see main.swift) — all the .swift files compile into one
// binary.
import Foundation
import FoundationModels

/// A tool as it arrives on the wire (the `reset` command's `tools[]`): the
/// model-facing surface plus the JSON Schema for its arguments. The `call`
/// implementation is never sent — it stays in Node.
struct WireTool: Decodable {
    let name: String
    let description: String
    let parameters: JSONValue
}

/// What Node sends back for a tool call: the textual result, or a failure message.
enum ToolReply {
    case result(String)
    case error(String)
}

/// Thrown when Node reports a tool call failed. The framework surfaces it to the
/// model, which can continue without that tool.
struct ToolCallError: Error, CustomStringConvertible {
    let message: String
    var description: String { message }
}

/// Bridges a model-invoked tool call out to Node and back. A `DynamicTool` can't run
/// the tool itself, so each `call` emits a `tool_call` event and suspends until Node
/// replies with a `tool_result` / `tool_error` (matched by `callId`). Modeled as an
/// actor so the stdin reader and the in-flight turn touch it safely; `callId`s are
/// `"<turnId>:<n>"`.
actor ToolBridge {
    private var turnId: String?
    private var counter = 0
    private var waiters: [String: CheckedContinuation<ToolReply, Never>] = [:]

    /// Mark the start of a turn so emitted `tool_call` events carry its id and the
    /// per-turn call counter restarts.
    func beginTurn(_ id: String?) {
        turnId = id
        counter = 0
    }

    /// Emit a `tool_call` for `name`/`argumentsJSON` and suspend until Node replies.
    func call(name: String, argumentsJSON: String) async -> ToolReply {
        counter += 1
        let callId = "\(turnId ?? "0"):\(counter)"
        return await withCheckedContinuation { continuation in
            // Register the waiter BEFORE emitting, so a fast `tool_result` can't race
            // ahead: `resolve` is actor-isolated and can't run until this body
            // suspends, by which point the waiter is already stored.
            waiters[callId] = continuation
            emitToolCall(name: name, callId: callId, argumentsJSON: argumentsJSON, id: turnId)
        }
    }

    /// Resume the suspended call matching `callId` (a no-op if unknown — e.g. a stale
    /// or duplicate reply).
    func resolve(callId: String, reply: ToolReply) {
        guard let continuation = waiters.removeValue(forKey: callId) else { return }
        continuation.resume(returning: reply)
    }
}

/// A generic tool standing in for any Node-defined tool. `parameters` is provided
/// explicitly (the compiled caller schema) rather than derived from `Arguments`,
/// since `Arguments` is the dynamic `GeneratedContent` carrier.
struct DynamicTool: Tool {
    typealias Arguments = GeneratedContent
    typealias Output = String

    let name: String
    let description: String
    let parameters: GenerationSchema
    let bridge: ToolBridge

    func call(arguments: GeneratedContent) async throws -> String {
        let reply = await bridge.call(name: name, argumentsJSON: arguments.jsonString)
        switch reply {
        case .result(let content):
            return content
        case .error(let message):
            throw ToolCallError(message: message)
        }
    }
}

/// Compile wire tool defs into `DynamicTool`s. A tool whose argument schema can't be
/// expressed natively is skipped with an `unsupportedSchema` diagnostic rather than
/// failing the whole session — the other tools still work.
func buildTools(_ defs: [WireTool], bridge: ToolBridge) -> [any Tool] {
    var tools: [any Tool] = []
    for def in defs {
        do {
            let schema = try compileSchema(from: def.parameters)
            tools.append(DynamicTool(name: def.name, description: def.description, parameters: schema, bridge: bridge))
        } catch let error as UnsupportedSchema {
            emitError("unsupportedSchema", "tool \(def.name): \(error.message)", id: nil)
        } catch {
            emitError("unsupportedSchema", "tool \(def.name): could not build a generation schema", id: nil)
        }
    }
    return tools
}
