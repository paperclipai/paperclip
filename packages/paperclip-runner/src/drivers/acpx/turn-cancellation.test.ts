import type { AcpRuntimeTurnResult } from "acpx/runtime";
import { afterEach, expect, it, vi } from "vitest";
import { withAcpxTurnCancellation } from "./turn-cancellation.js";
import type { AcpxRuntimeTurn } from "./runtime-host.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
};
function fixture() {
  const terminal = deferred<AcpRuntimeTurnResult>();
  const stream = deferred<IteratorResult<{ type: "text_delta"; text: string }>>();
  const cleanup = deferred<void>();
  const cancel = vi.fn(async () => undefined), close = vi.fn(() => cleanup.promise);
  const raw: AcpxRuntimeTurn = {
    requestId: "turn", promptStarted: Promise.resolve(), result: terminal.promise,
    cancel, closeStream: vi.fn(async () => undefined),
    events: { [Symbol.asyncIterator]: () => ({ next: () => stream.promise }) },
  };
  return { terminal, stream, cleanup, cancel, close, turn: withAcpxTurnCancellation(raw, close, 20) };
}
afterEach(() => vi.useRealTimers());

it("does not treat acknowledgement or stdout EOF during cleanup as terminal proof", async () => {
  vi.useFakeTimers(); const f = fixture();
  const next = f.turn.events[Symbol.asyncIterator]().next();
  const stopped = f.turn.cancel({ reason: "operator stop" });
  let settled = false; void f.turn.result.finally(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(19);
  expect(f.cancel).toHaveBeenCalledExactlyOnceWith({ reason: "operator stop" });
  expect(f.close).not.toHaveBeenCalled(); expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.close).toHaveBeenCalledExactlyOnceWith("operator stop");
  f.stream.reject(new Error("stdout closed during cleanup"));
  f.terminal.resolve({ status: "failed", error: { message: "EOF", retryable: false } });
  await Promise.resolve(); expect(settled).toBe(false);
  f.cleanup.resolve();
  await stopped;
  await expect(f.turn.result).resolves.toEqual({ status: "cancelled", stopReason: "cancelled_after_runtime_close" });
  await expect(next).resolves.toMatchObject({ done: true });
});

it("never publishes cancellation when owned provider cleanup fails", async () => {
  vi.useFakeTimers(); const f = fixture();
  const result = expect(f.turn.result).rejects.toThrow("provider still alive");
  const next = expect(f.turn.events[Symbol.asyncIterator]().next()).rejects.toThrow("provider still alive");
  const stopped = expect(f.turn.cancel()).rejects.toThrow("provider still alive");
  await vi.advanceTimersByTimeAsync(20); f.cleanup.reject(new Error("provider still alive"));
  await Promise.all([result, next, stopped]);
});

it.each(["completed", "failed"] as const)("waits after clean EOF for %s owned cleanup", async outcome => {
  vi.useFakeTimers(); const f = fixture();
  const next = f.turn.events[Symbol.asyncIterator]().next();
  const stopped = f.turn.cancel();
  const nextOutcome = next.then(() => "ended", () => "failed");
  let streamSettled = false;
  void nextOutcome.then(() => { streamSettled = true; });
  const result = outcome === "failed"
    ? expect(f.turn.result).rejects.toThrow("cleanup failed")
    : expect(f.turn.result).resolves.toMatchObject({ status: "cancelled" });
  const cancellation = outcome === "failed"
    ? expect(stopped).rejects.toThrow("cleanup failed")
    : expect(stopped).resolves.toBeUndefined();
  f.stream.resolve({ done: true, value: undefined });
  await vi.advanceTimersByTimeAsync(20);
  expect(f.close).toHaveBeenCalledOnce();
  expect(streamSettled).toBe(false);
  if (outcome === "failed") f.cleanup.reject(new Error("cleanup failed"));
  else f.cleanup.resolve();
  await Promise.all([result, cancellation]);
  await expect(nextOutcome).resolves.toBe(outcome === "failed" ? "failed" : "ended");
});

it.each(["completed", "cancelled", "failed"] as const)("settles a racing provider %s terminal without waiting for the run timeout", async status => {
  const f = fixture();
  const stopped = f.turn.cancel();
  const terminal: AcpRuntimeTurnResult = status === "failed" ? { status, error: { message: "provider failure", retryable: false } } : { status };
  f.terminal.resolve(terminal);
  await stopped;
  await expect(f.turn.result).resolves.toEqual(status === "completed" ? { status: "cancelled", stopReason: "cancelled_after_provider_completed" } : terminal);
  expect(f.close).not.toHaveBeenCalled();
});

it("keeps a provider transport failure distinct from a cancellation timeout", async () => {
  const f = fixture();
  const result = expect(f.turn.result).rejects.toThrow("provider stdout closed");
  const stopped = expect(f.turn.cancel()).rejects.toThrow("provider stdout closed");
  f.terminal.reject(new Error("provider stdout closed"));
  await Promise.all([result, stopped]); expect(f.close).not.toHaveBeenCalled();
});

it("drains ordinary output even when its normal result is already settled", async () => {
  const f = fixture();
  f.terminal.resolve({ status: "completed" });
  const iterator = f.turn.events[Symbol.asyncIterator]();
  f.stream.resolve({ value: { type: "text_delta", text: "final bytes" }, done: false });
  await expect(iterator.next()).resolves.toEqual({ value: { type: "text_delta", text: "final bytes" }, done: false });
  await iterator.return?.();
  await expect(f.turn.result).resolves.toEqual({ status: "completed" });
});
