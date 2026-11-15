import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStartupTimeline } from "./startup-timeline.js";

let uptime = 0;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const timeline = () => createStartupTimeline({ uptimeMs: () => uptime, log: log as never, warnAfterMs: 30_000 });

beforeEach(() => {
  uptime = 0;
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

it("never waits for a background step and reports it outstanding at readiness", async () => {
  const startup = timeline();
  const finished = vi.fn();
  void startup.background("delivery_workers", () => new Promise(() => {})).then(finished);
  await startup.precondition("listen", async () => { uptime = 40; });
  uptime = 100;
  startup.mark("ready");
  startup.log("startup timeline at readiness");
  expect(finished).not.toHaveBeenCalled();
  expect(log.info).toHaveBeenCalledExactlyOnceWith({
    processUptimeMs: 100,
    startupSteps: { ready: 100 },
    readinessStepsMs: { listen: 40 },
    backgroundStepsMs: {},
    backgroundStepsOutstanding: ["delivery_workers"],
  }, "startup timeline at readiness");
});

it("names a precondition still holding readiness every interval until it ends", async () => {
  const startup = timeline();
  const gate = deferred<string>();
  const result = startup.precondition("native_recovery", () => gate.promise);
  uptime = 30_000;
  await vi.advanceTimersByTimeAsync(30_000);
  uptime = 60_000;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(log.warn.mock.calls).toEqual([
    [{ startupStep: "native_recovery", waitingMs: 30_000, holdsReadiness: true }, "startup step is still holding readiness"],
    [{ startupStep: "native_recovery", waitingMs: 60_000, holdsReadiness: true }, "startup step is still holding readiness"],
  ]);
  gate.resolve("adopted");
  await expect(result).resolves.toBe("adopted");
  await vi.advanceTimersByTimeAsync(90_000);
  expect(log.warn).toHaveBeenCalledTimes(2);
});

it("propagates a precondition failure and records its duration", async () => {
  const startup = timeline();
  const error = new Error("ineligible");
  await expect(startup.precondition("cloud_configuration", async () => { uptime = 5; throw error; })).rejects.toBe(error);
  startup.log("ready");
  expect(log.info.mock.calls[0]![0]).toMatchObject({ readinessStepsMs: { cloud_configuration: 5 } });
});

it("logs a slow or failed background step by name and never rejects", async () => {
  const startup = timeline();
  const slow = deferred<void>();
  const slowStep = startup.background("terminal_workspaces", () => slow.promise);
  const failed = startup.background("github_connections", async () => { throw new Error("GitHub unavailable"); });
  await expect(failed).resolves.toBeUndefined();
  expect(log.error).toHaveBeenCalledExactlyOnceWith(
    { err: expect.any(Error), startupStep: "github_connections" }, "startup background step failed");
  uptime = 30_000;
  await vi.advanceTimersByTimeAsync(30_000);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(log.warn.mock.calls).toEqual([[{ startupStep: "terminal_workspaces", waitingMs: 30_000, holdsReadiness: false },
    "startup step is still running in the background"]]);
  uptime = 95_000;
  slow.resolve(undefined);
  await slowStep;
  expect(log.info).toHaveBeenCalledWith({ startupStep: "terminal_workspaces", durationMs: 95_000 }, "startup background step finished");
});
