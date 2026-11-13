import { afterEach, expect, it, vi } from "vitest";
import { waitForWarmAttachmentReadiness } from "./warm-attachment-readiness.js";

afterEach(() => vi.useRealTimers());

it("preserves the command journal while a remote provider takes a minute to settle", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  let commands = 12;
  const snapshot = vi.fn(async () => {
    if (++commands >= 500) throw new Error("Durable PRP command journal bound exceeded.");
    return { warmAttachReady: Date.now() >= 60_000, warmAttachBlockers: Date.now() >= 60_000 ? [] : ["pending_messages"] };
  });
  const result = waitForWarmAttachmentReadiness({ graceMs: 120_000, waitForConnection: async () => {}, snapshot })
    .then(() => "ready", error => String(error));
  await vi.advanceTimersByTimeAsync(120_000);
  expect(await result).toBe("ready");
  expect(commands).toBeLessThan(200);
});

it("keeps the fast path and requires two consecutive ready snapshots", async () => {
  vi.useFakeTimers();
  const sequence = [true, false, true, true];
  const snapshot = vi.fn(async () => ({ warmAttachReady: sequence.shift(), warmAttachBlockers: [] }));
  const waiting = waitForWarmAttachmentReadiness({ graceMs: 5_000, waitForConnection: async () => {}, snapshot });
  await vi.advanceTimersByTimeAsync(200);
  await waiting;
  expect(snapshot).toHaveBeenCalledTimes(4);
});

it("fails closed with the actual blocker when quiescence never arrives", async () => {
  vi.useFakeTimers();
  const snapshot = vi.fn(async () => ({ warmAttachReady: false, warmAttachBlockers: ["pending_runtime_requests"] }));
  const result = waitForWarmAttachmentReadiness({ graceMs: 120_000, waitForConnection: async () => {}, snapshot })
    .then(() => "unexpected-ready", error => String(error));
  await vi.advanceTimersByTimeAsync(122_000);
  expect(await result).toContain('native_runner_warm_attachment_not_quiescent: ["pending_runtime_requests"]');
  expect(snapshot.mock.calls.length).toBeLessThan(200);
});

it("does not reset the probe budget when readiness alternates", async () => {
  vi.useFakeTimers();
  let calls = 0;
  const snapshot = vi.fn(async () => ({ warmAttachReady: ++calls % 2 === 0, warmAttachBlockers: ["pending_events"] }));
  const result = waitForWarmAttachmentReadiness({ graceMs: 120_000, waitForConnection: async () => {}, snapshot })
    .then(() => "unexpected-ready", error => String(error));
  await vi.advanceTimersByTimeAsync(122_000);
  expect(await result).toContain("native_runner_warm_attachment_not_quiescent");
  expect(calls).toBeLessThan(350);
});

it("confirms readiness near the deadline after one unsettled observation", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  let recoveredProbes = 0;
  const result = waitForWarmAttachmentReadiness({
    graceMs: 5_000,
    waitForConnection: async () => {},
    snapshot: async () => ({
      warmAttachReady: Date.now() >= 4_400 && ++recoveredProbes !== 2,
      warmAttachBlockers: [],
    }),
  }).then(() => "ready", error => String(error));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(await result).toBe("ready");
});
