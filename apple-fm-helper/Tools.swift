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

/// Thrown when Node reports a tool call failed. The framework surfaces it to the
/// model, which can continue without that tool.
struct ToolCallError: Error, CustomStringConvertible {
    let message: String
    var description: String { message }
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
