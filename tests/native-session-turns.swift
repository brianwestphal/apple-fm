// Compiled with SessionTurns.swift to exercise scheduling without a model asset.
@main
struct NativeSessionTurnsTest {
    static func main() async {
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

    static func require(_ condition: Bool, line: UInt = #line) {
        precondition(condition, "Session turn assertion failed at line \(line)")
    }
}
