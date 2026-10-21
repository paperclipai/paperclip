import { afterEach, expect, it, vi } from "vitest";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { readRemoteRunnerRecoveryError } from "./remote-runner-recovery-diagnostics.js";
import { readRemoteRunnerRecoveryProbe } from "./remote-runner-recovery-probe.js";

afterEach(() => vi.useRealTimers());

const timeout = { exitCode: null, signal: null, timedOut: true, stdout: "", stderr: "", pid: null, startedAt: "2026-10-15T00:00:00Z" };

it("shares the remaining deadline across timed-out reads", async () => {
  vi.useFakeTimers();
  const execute = vi.fn(async (request) => {
    await new Promise(resolve => setTimeout(resolve, request.timeoutMs));
    return timeout;
  });
  const result = readRemoteRunnerRecoveryProbe({
    runner: { execute } as CommandManagedRuntimeRunner,
    request: { command: "sh" }, stage: "identity_marker",
    readOnly: true, deadline: Date.now() + 15_000,
  }).catch(readRemoteRunnerRecoveryError);
  await vi.runAllTimersAsync();
  expect(await result).toEqual({ stage: "identity_marker", reason: "probe_timeout" });
  expect(execute.mock.calls.map(([request]) => request.timeoutMs)).toEqual([10_000, 4_750]);
});

it("never retries a signal when its acknowledgement is lost", async () => {
  const execute = vi.fn().mockRejectedValue(new Error("connection lost"));
  const result = await readRemoteRunnerRecoveryProbe({
    runner: { execute }, request: { command: "sh" }, stage: "process_verification",
    readOnly: false, deadline: Date.now() + 30_000,
  }).catch(readRemoteRunnerRecoveryError);
  expect(result).toEqual({ stage: "process_verification", reason: "probe_transport_failed" });
  expect(execute).toHaveBeenCalledTimes(1);
});

it("returns a definitive ownership conflict without retrying it", async () => {
  const conflict = { ...timeout, timedOut: false, exitCode: 47 };
  const execute = vi.fn().mockResolvedValue(conflict);
  expect(await readRemoteRunnerRecoveryProbe({
    runner: { execute }, request: { command: "sh" }, stage: "process_verification",
    readOnly: true, deadline: Date.now() + 30_000,
  })).toBe(conflict);
  expect(execute).toHaveBeenCalledTimes(1);
});
