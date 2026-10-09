import { expect, it, vi } from "vitest";
import { runnerdRecoveryInternals } from "./runnerd-codex-transport.js";

it.each([
  ["hermes", "session.open", true],
  ["hermes", "runner.drain", true],
  ["hermes", "turn.start", true],
  ["codex", "session.open", false],
  ["hermes", "session.snapshot", false],
  ["hermes", "turn.stop", false],
] as const)("bounds %s %s admission around a delayed durable receipt", async (agent, type, coldStartup) => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  try {
    let status = "pending";
    const completed = setTimeout(() => { status = "completed"; }, 35_000);
    const result = runnerdRecoveryInternals.awaitRunnerdCommand({
      type, command: () => ({ status }), throwIfFailed: () => undefined,
      runnerHasExited: async () => false,
      deadline: Date.now() + runnerdRecoveryInternals.runnerdCommandTimeoutMs(type, "acpx", agent),
      timeoutPrefix: () => "provider_transport_failed",
    }).then(() => "accepted", (error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(35_000);
    if (coldStartup) expect(await result).toBe("accepted");
    else expect(await result).toBe(`provider_transport_failed: PRP command ${type} timed out`);
    clearTimeout(completed);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it("still rejects a Hermes startup whose receipt never arrives", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  try {
    let settled = false;
    const result = runnerdRecoveryInternals.awaitRunnerdCommand({
      type: "session.open", command: () => ({ status: "pending" }),
      throwIfFailed: () => undefined, runnerHasExited: async () => false,
      deadline: Date.now() + runnerdRecoveryInternals.runnerdCommandTimeoutMs("session.open", "acpx", "hermes"),
      timeoutPrefix: () => "runner_local_connect_failed",
    }).then(() => "accepted", (error: Error) => { settled = true; return error.message; });
    await vi.advanceTimersByTimeAsync(74_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe("runner_local_connect_failed: PRP command session.open timed out");
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
