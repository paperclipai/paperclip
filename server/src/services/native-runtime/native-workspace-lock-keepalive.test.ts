import { setImmediate } from "node:timers/promises";
import * as timers from "node:timers/promises";
import { expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { withWorkspaceLockKeepalive } from "./native-workspace-lock-keepalive.js";

vi.mock("node:timers/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:timers/promises")>();
  return { ...actual, setTimeout: vi.fn(actual.setTimeout) };
});

it.each([0, -1, NaN, Infinity])("does not probe when the idle timeout is %s", async timeout => {
  const execute = vi.fn();
  const value = {};
  let finish!: (value: object) => void;
  const pending = new Promise<object>(resolve => { finish = resolve; });
  vi.useFakeTimers();
  const sleep = vi.mocked(timers.setTimeout);
  const originalSleep = sleep.getMockImplementation()!;
  sleep.mockClear().mockImplementation((_delay, result, options) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(result), 30_000);
    options?.signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }, { once: true });
  }));
  const result = withWorkspaceLockKeepalive({ execute } as unknown as Db, timeout, () => pending);
  try {
    await vi.advanceTimersByTimeAsync(60_001);
    expect(execute).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  } finally {
    finish(value);
    await expect(result).resolves.toBe(value);
    sleep.mockImplementation(originalSleep);
    vi.useRealTimers();
  }
});

it("joins an in-flight probe before releasing the lock scope", async () => {
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const execute = vi.fn(async () => { entered(); await pending; });
  let settled = false;
  const result = withWorkspaceLockKeepalive({ execute } as unknown as Db, 3, async () => {
    await started;
    return 42;
  }).then(value => { settled = true; return value; });
  try {
    await started;
    await setImmediate();
    expect(settled).toBe(false);
    expect(execute).toHaveBeenCalledOnce();
  } finally { finish(); }
  await expect(result).resolves.toBe(42);
  await setImmediate();
  expect(execute).toHaveBeenCalledOnce();
});

it("preserves the work error when its keepalive query fails", async () => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const execute = vi.fn(async () => { entered(); throw new Error("connection lost"); });
  const original = new Error("copyback failed");
  const work = vi.fn(async () => { await started; throw original; });
  await expect(withWorkspaceLockKeepalive({ execute } as unknown as Db, 3, work)).rejects.toBe(original);
  expect(work).toHaveBeenCalledOnce();
  await setImmediate();
  expect(execute).toHaveBeenCalledOnce();
});
