// Guided generation: translate a request's JSON Schema into a native
// `GenerationSchema` so `respond(to:schema:)` can guarantee the output conforms.
// Part of apple-fm-helper (see main.swift) — all the .swift files here are
// compiled together into one binary. See docs/6-guided-generation.md.
import Foundation
import FoundationModels

/// Thrown when a request's JSON Schema uses a construct the native
/// `DynamicGenerationSchema` can't express. Surfaced to the caller as the
/// `unsupportedSchema` error code — strict, no prompt-guided fallback.
struct UnsupportedSchema: Error { let message: String }

private func stringField(_ object: [String: JSONValue], _ key: String) -> String? {
    if case .string(let value)? = object[key] { return value }
    return nil
}

private func decimalField(_ object: [String: JSONValue], _ key: String) throws -> Double? {
    guard let field = object[key] else { return nil }
    guard case .number(let value) = field, value.isFinite else {
        throw UnsupportedSchema(message: "\(key) must be a finite number")
    }
    return value
}

private func integerField(
    _ object: [String: JSONValue], _ key: String, rounding: FloatingPointRoundingRule? = nil
) throws -> Int? {
    guard let value = try decimalField(object, key) else { return nil }
    let bound = rounding.map { value.rounded($0) } ?? value
    guard let integer = Int(exactly: bound) else {
        throw UnsupportedSchema(message: "\(key) is outside the supported integer range or is not an integer")
    }
    return integer
}

private let unsupportedSchemaKeywords = [
    "$ref", "$defs", "definitions", "oneOf", "anyOf", "allOf", "not",
    "if", "then", "else", "patternProperties", "propertyNames",
    "dependentRequired", "dependentSchemas", "dependencies", "prefixItems",
    "contains", "unevaluatedProperties", "unevaluatedItems", "const",
]

private func requiredKeys(_ field: JSONValue?, properties: [String: JSONValue]) throws -> Set<String> {
    guard let field else { return [] }
    guard case .array(let entries) = field else {
        throw UnsupportedSchema(message: "required must be an array of property names")
    }
    var names: Set<String> = []
    for entry in entries {
        guard case .string(let name) = entry, properties[name] != nil, names.insert(name).inserted else {
            throw UnsupportedSchema(message: "required must contain unique names declared in properties")
        }
    }
    return names
}

/// `minimum` / `maximum` → integer range guides (a documented range, or an open
/// bound). A `minimum > maximum` schema is rejected so the `ClosedRange` is valid.
private func intGuides(_ object: [String: JSONValue]) throws -> [GenerationGuide<Int>] {
    let lo = try integerField(object, "minimum", rounding: .up)
    let hi = try integerField(object, "maximum", rounding: .down)
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
    let lo = try decimalField(object, "minimum")
    let hi = try decimalField(object, "maximum")
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
    if let key = unsupportedSchemaKeywords.first(where: { object[$0] != nil }) {
        throw UnsupportedSchema(message: "unsupported JSON Schema keyword: \(key)")
    }
    if let additional = object["additionalProperties"] {
        // The emitted object already contains only the declared properties.
        guard case .bool = additional else {
            throw UnsupportedSchema(message: "additionalProperties schemas are not supported")
        }
    }
    let description = stringField(object, "description")
    guard let type = stringField(object, "type") else {
        throw UnsupportedSchema(message: "schema node is missing a string \"type\" (oneOf / anyOf / allOf / $ref are not supported)")
    }
    if object["enum"] != nil && type != "string" {
        throw UnsupportedSchema(message: "only string enums are supported")
    }
    switch type {
    case "object":
        guard case .object(let properties)? = object["properties"] else {
            throw UnsupportedSchema(message: "object schema is missing \"properties\"")
        }
        let required = try requiredKeys(object["required"], properties: properties)
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
        if let enumeration = object["enum"] {
            guard case .array(let choices) = enumeration, !choices.isEmpty else {
                throw UnsupportedSchema(message: "enum must be a non-empty array of strings")
            }
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
        let minimum = try integerField(object, "minItems")
        let maximum = try integerField(object, "maxItems")
        guard (minimum ?? 0) >= 0, (maximum ?? 0) >= 0,
              (minimum ?? 0) <= (maximum ?? Int.max) else {
            throw UnsupportedSchema(message: "minItems and maxItems must be non-negative and ordered")
        }
        return DynamicGenerationSchema(arrayOf: itemSchema, minimumElements: minimum, maximumElements: maximum)
    default:
        throw UnsupportedSchema(message: "unsupported JSON Schema type: \(type)")
    }
}

/// Build a native `GenerationSchema` from the request's JSON Schema. Nested schemas
/// are inlined, so `dependencies` is empty.
func compileSchema(from schema: JSONValue) throws -> GenerationSchema {
    var counter = 0
    let root = try dynamicSchema(schema, name: "Output", counter: &counter)
    return try GenerationSchema(root: root, dependencies: [])
}
