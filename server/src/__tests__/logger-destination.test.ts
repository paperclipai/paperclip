import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createResilientDestination } from "../middleware/logger-destination.js";

/**
 * Regression test for the 2026-09-14 outage.
 *
 * pino-pretty runs on a worker thread (thread-stream). When that worker dies —
 * a full disk, an OOM kill, a crash inside pino-pretty — every subsequent
 * ThreadStream.write() calls `setImmediate(() => stream.emit("error", err))`.
 * An "error" event with no listener is a FATAL uncaught exception in Node, so
 * failing to write a log line killed the entire server:
 *
 *   Error: the worker has exited
 *       at ThreadStream.write (thread-stream@4.2.0/index.js:262:19)
 *       at Pino.write (pino/lib/proto.js:243:10)
 *       at Pino.LOG [as info] (pino/lib/tools.js:69:21)
 *       at WorkspaceGitOperationScheduler.finishSuccess (...:711:12)
 *
 * Logging is observability, never a dependency of correctness. If it breaks,
 * the server must keep serving.
 */

/** Stands in for thread-stream: writes land in `written` until it is killed. */
class FakeThreadStream extends EventEmitter {
  written: string[] = [];
  private dead = false;

  write(chunk: string): boolean {
    if (this.dead) {
      // Exactly what thread-stream does: async emit, never a sync throw.
      setImmediate(() => this.emit("error", new Error("the worker has exited")));
      return false;
    }
    this.written.push(chunk);
    return true;
  }

  kill() {
    this.dead = true;
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("createResilientDestination", () => {
  it("registers an error listener so a dead worker cannot crash the process", () => {
    const primary = new FakeThreadStream();
    createResilientDestination(primary);

    // The whole outage reduces to this number having been 0.
    expect(primary.listenerCount("error")).toBeGreaterThan(0);
  });

  it("passes log lines through to the primary stream while it is healthy", () => {
    const primary = new FakeThreadStream();
    const fallback = { write: vi.fn() };
    const destination = createResilientDestination(primary, fallback);

    destination.write("hello\n");

    expect(primary.written).toEqual(["hello\n"]);
    expect(fallback.write).not.toHaveBeenCalled();
  });

  it("keeps logging to the fallback once the worker has died", async () => {
    const primary = new FakeThreadStream();
    const fallback = { write: vi.fn() };
    const destination = createResilientDestination(primary, fallback, { report: vi.fn() });

    primary.kill();
    destination.write("lost line\n"); // in flight when the worker died
    await tick(); // the async "error" emit lands here

    destination.write("survived\n");

    expect(fallback.write).toHaveBeenCalledWith("survived\n");
  });

  it("reports the failure exactly once, no matter how many lines follow", async () => {
    const primary = new FakeThreadStream();
    const report = vi.fn();
    const destination = createResilientDestination(primary, { write: vi.fn() }, { report });

    primary.kill();
    for (let i = 0; i < 50; i++) destination.write(`line ${i}\n`);
    await tick();
    for (let i = 0; i < 50; i++) destination.write(`line ${i}\n`);
    await tick();

    // A dead logger must not become a log flood of its own.
    expect(report).toHaveBeenCalledTimes(1);
    expect(String(report.mock.calls[0][0])).toContain("the worker has exited");
  });

  it("survives a fallback that is also broken", async () => {
    const primary = new FakeThreadStream();
    const fallback = {
      write: vi.fn(() => {
        throw new Error("ENOSPC: no space left on device");
      }),
    };
    const destination = createResilientDestination(primary, fallback, { report: vi.fn() });

    primary.kill();
    await tick();

    // Disk full kills the worker AND the fallback. Still must not throw.
    expect(() => destination.write("anything\n")).not.toThrow();
  });

  it("tolerates a destination that is not an event emitter", () => {
    // A bare `{ write }` object is a valid pino DestinationStream, so the
    // guard must not assume `.on` exists.
    const plain = { write: vi.fn() };
    const fallback = { write: vi.fn() };
    const destination = createResilientDestination(plain as never, fallback);

    expect(() => destination.write("hello\n")).not.toThrow();
    expect(plain.write).toHaveBeenCalledWith("hello\n");
  });

  it("never routes its own failure back through the broken stream", async () => {
    const primary = new FakeThreadStream();
    const fallback = { write: vi.fn() };
    const destination = createResilientDestination(primary, fallback, { report: vi.fn() });

    primary.kill();
    destination.write("trigger\n");
    await tick();
    await tick();

    // Reporting through pino would re-enter the dead stream and loop forever.
    expect(primary.written).toEqual([]);
  });
});
