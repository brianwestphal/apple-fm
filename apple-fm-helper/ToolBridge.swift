/// What Node sends back for a tool call: the textual result, or a failure message.
enum ToolReply {
    case result(String)
    case error(String)
}

/// Bridges a model-invoked tool call out to Node and back. A `DynamicTool` can't run
/// the tool itself, so each `call` emits a `tool_call` event and suspends until Node
/// replies with a `tool_result` / `tool_error` (matched by `callId`). Modeled as an
/// actor so the stdin reader and the in-flight turn touch it safely; `callId`s are
/// `"<turnId>:<n>"`.
actor ToolBridge {
    private let emit: @Sendable (String, String, String, String?) -> Void
    private var turnId: String?
    private var counter = 0
    private var cancelled = false
    private var waiters: [String: CheckedContinuation<ToolReply, Never>] = [:]

    init(emit: @escaping @Sendable (String, String, String, String?) -> Void) {
        self.emit = emit
    }

    /// Mark the start of a turn so emitted `tool_call` events carry its id and the
    /// per-turn call counter restarts.
    func beginTurn(_ id: String?) {
        turnId = id
        counter = 0
        cancelled = false
    }

    /// Wake calls suspended in a cancelled native turn so it can finish promptly.
    func cancelTurn(_ id: String?) {
        guard turnId == id else { return }
        cancelled = true
        for continuation in waiters.values {
            continuation.resume(returning: .error("tool call interrupted"))
        }
        waiters.removeAll()
    }

    /// Emit a `tool_call` for `name`/`argumentsJSON` and suspend until Node replies.
    func call(name: String, argumentsJSON: String) async -> ToolReply {
        guard !cancelled, !Task.isCancelled else { return .error("tool call interrupted") }
        counter += 1
        let callId = "\(turnId ?? "0"):\(counter)"
        return await withCheckedContinuation { continuation in
            // Register the waiter BEFORE emitting, so a fast `tool_result` can't race
            // ahead: `resolve` is actor-isolated and can't run until this body
            // suspends, by which point the waiter is already stored.
            waiters[callId] = continuation
            emit(name, callId, argumentsJSON, turnId)
        }
    }

    /// Resume the suspended call matching `callId` (a no-op if unknown — e.g. a stale
    /// or duplicate reply).
    func resolve(callId: String, reply: ToolReply) {
        guard let continuation = waiters.removeValue(forKey: callId) else { return }
        continuation.resume(returning: reply)
    }
}
