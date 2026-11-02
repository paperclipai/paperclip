import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ownTestPostgres } from "./test-postgres-owner.js";

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(() => true),
  });
  const raw = {
    initialise: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    process: child as unknown as ChildProcess,
  };
  const owner = ownTestPostgres(raw);
  function exit() { child.exitCode = 0; child.emit("exit", 0, null); }
  return { child, raw, owner, exit };
}

afterEach(() => { vi.useRealTimers(); });

describe.skipIf(process.platform === "win32")("test PostgreSQL ownership", () => {
  it("waits for fast shutdown and makes concurrent cleanup idempotent", async () => {
    const before = process.listenerCount("exit");
    const f = fixture();
    const stop = f.owner.stop();
    expect(f.owner.stop()).toBe(stop);
    expect(f.child.kill).toHaveBeenCalledWith("SIGINT");
    f.exit();
    await stop;
    await f.owner.stop();
    expect(f.child.kill).toHaveBeenCalledTimes(1);
    expect(process.listenerCount("exit")).toBe(before);
  });

  it("does not call the dependency's stop after the process already exited", async () => {
    const f = fixture();
    f.exit();
    await f.owner.stop();
    expect(f.raw.stop).not.toHaveBeenCalled();
    expect(f.child.kill).not.toHaveBeenCalled();
  });

  it("uses immediate PostgreSQL shutdown when fast shutdown times out", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const stop = f.owner.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.child.kill.mock.calls).toEqual([["SIGINT"], ["SIGQUIT"]]);
    f.exit();
    await stop;
    expect(f.child.kill).not.toHaveBeenCalledWith("SIGKILL");
  });

  it("reports a shutdown failure instead of declaring the process stopped", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const failure = expect(f.owner.stop()).rejects.toThrow("data directory is retained");
    await vi.advanceTimersByTimeAsync(10_000);
    await failure;
    f.exit();
    await f.owner.stop();
  });

  it("keeps one exit hook while two servers have different owners", async () => {
    const before = process.listenerCount("exit");
    const a = fixture(), b = fixture();
    expect(process.listenerCount("exit")).toBe(before + 1);
    a.exit(); await a.owner.stop();
    expect(process.listenerCount("exit")).toBe(before + 1);
    b.exit(); await b.owner.stop();
    expect(process.listenerCount("exit")).toBe(before);
  });
});
