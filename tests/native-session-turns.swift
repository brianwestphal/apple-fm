// Exercises native scheduling and the tool bridge without a model asset.
@main
struct NativeSessionTurnsTest {
    static func main() async {
        await testTurns()
        await testToolReplies()
        await testConcurrentToolReplies()
    }

    static func testConcurrentToolReplies() async {
        let (calls, emitted) = AsyncStream<(name: String, id: String)>.makeStream()
        let bridge = ToolBridge { name, id, _, _ in emitted.yield((name, id)) }
        await bridge.beginTurn("parallel")
        let left = Task { await bridge.call(name: "left", argumentsJSON: "{}") }
        let right = Task { await bridge.call(name: "right", argumentsJSON: "{}") }
        var wire = calls.makeAsyncIterator()
        guard let first = await wire.next(), let second = await wire.next() else {
            fatalError("expected two requests before sending a reply")
        }
        require(first.id != second.id)
        await bridge.resolve(callId: second.id, reply: .result(second.name))
        await bridge.resolve(callId: first.id, reply: .result(first.name))
        guard case .result("left") = await left.value, case .result("right") = await right.value else {
            fatalError("out-of-order replies completed the wrong tool calls")
        }
    }

    static func testTurns() async {
        let turns = SessionTurns()
        let (started, ready) = AsyncStream<Void>.makeStream()
        let (release, resume) = AsyncStream<Void>.makeStream()
        require(await turns.enqueue("active"))
        let active = Task {
            await turns.run("active") {
                ready.yield(())
                for await _ in release { break }
                require(!Task.isCancelled)
            }
        }
        var start = started.makeAsyncIterator()
        _ = await start.next()

        require(await turns.enqueue("queued"))
        require(!(await turns.cancel("unknown")))
        require(!(await turns.cancel("queued")))
        resume.yield(())
        require(await active.value)
        require(!(await turns.run("queued") { fatalError("cancelled queued turn ran") }))

        require(await turns.enqueue("next"))
        let (nextStarted, nextReady) = AsyncStream<Void>.makeStream()
        let (finishNext, nextResume) = AsyncStream<Void>.makeStream()
        let next = Task {
            await turns.run("next") {
                nextReady.yield(())
                for await _ in finishNext { break }
                require(Task.isCancelled)
            }
        }
        var nextStart = nextStarted.makeAsyncIterator()
        _ = await nextStart.next()
        require(!(await turns.cancel("active")))
        require(!(await turns.enqueue("next")))
        require(await turns.cancel("next"))
        nextResume.finish()
        require(await next.value)
        require(!(await turns.cancel("next")))
    }

    static func testToolReplies() async {
        let (calls, emitted) = AsyncStream<String>.makeStream()
        var wire = calls.makeAsyncIterator()
        let bridge = ToolBridge { _, callId, _, _ in emitted.yield(callId) }

        await bridge.beginTurn("first")
        let first = Task { await bridge.call(name: "test", argumentsJSON: "{}") }
        guard let firstId = await wire.next() else { fatalError("missing first call") }
        await bridge.resolve(callId: firstId, reply: .result("first"))
        await bridge.resolve(callId: firstId, reply: .error("duplicate"))
        guard case .result("first") = await first.value else { fatalError("duplicate changed first reply") }

        await bridge.beginTurn("second")
        let second = Task { await bridge.call(name: "test", argumentsJSON: "{}") }
        guard let secondId = await wire.next() else { fatalError("missing second call") }
        require(firstId != secondId)
        await bridge.resolve(callId: firstId, reply: .result("late"))
        await bridge.cancelTurn("first")
        await bridge.resolve(callId: secondId, reply: .result("second"))
        guard case .result("second") = await second.value else { fatalError("old turn changed second reply") }

        await bridge.beginTurn("third")
        let third = Task { await bridge.call(name: "test", argumentsJSON: "{}") }
        guard let thirdId = await wire.next() else { fatalError("missing third call") }
        await bridge.cancelTurn("third")
        await bridge.resolve(callId: thirdId, reply: .result("after cancel"))
        guard case .error = await third.value else { fatalError("cancelled reply was delivered") }
    }

    static func require(_ condition: Bool, line: UInt = #line) {
        precondition(condition, "Session turn assertion failed at line \(line)")
    }
}
