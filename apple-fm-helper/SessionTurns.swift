/// Tracks cancelable turns while a separate worker executes commands in wire order.
actor SessionTurns {
    private var queued: [String: Bool] = [:]
    private var active: (id: String?, task: Task<Void, Never>)?

    func enqueue(_ id: String?) -> Bool {
        guard let id else { return true }
        guard queued[id] == nil, active?.id != id else { return false }
        queued[id] = false
        return true
    }

    func discardQueued(_ id: String?) {
        if let id { queued.removeValue(forKey: id) }
    }

    /// Returns `false` for a turn cancelled before it started.
    func run(_ id: String?, operation: @escaping @Sendable () async -> Void) async -> Bool {
        if let id, queued.removeValue(forKey: id) == true { return false }
        let task = Task { await operation() }
        active = (id, task)
        await task.value
        active = nil
        return true
    }

    /// Returns `true` if a running turn was cancelled and its tool waiters need waking.
    func cancel(_ id: String?) -> Bool {
        guard let id else { return false }
        if let active, active.id == id {
            active.task.cancel()
            return true
        }
        if queued[id] != nil { queued[id] = true }
        return false
    }
}
