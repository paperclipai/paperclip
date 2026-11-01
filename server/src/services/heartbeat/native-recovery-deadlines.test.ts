import type { Db } from "@paperclipai/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { heartbeatService, startTaskDrain, stopTaskDrain } from "../heartbeat.js";
import type { HeartbeatRecoveryDependencies } from "./recovery.js";

const hooks = vi.hoisted(() => ({
  schedule: undefined as HeartbeatRecoveryDependencies["scheduleNativeSessionResumeDispatch"] | undefined,
  restart: vi.fn(async () => []),
  resume: vi.fn(async () => []),
  queue: vi.fn(async () => undefined),
}));

vi.mock("./recovery.js", async original => {
  const module = await original<typeof import("./recovery.js")>();
  return { ...module, createHeartbeatRecovery: (db: Db, dependencies: HeartbeatRecoveryDependencies) => {
    hooks.schedule = dependencies.scheduleNativeSessionResumeDispatch;
    return { ...module.createHeartbeatRecovery(db, dependencies), recoverNativeRunsAfterRestart: hooks.restart };
  } };
});
vi.mock("./queue.js", async original => {
  const module = await original<typeof import("./queue.js")>();
  return { ...module, createHeartbeatQueue: (...args: Parameters<typeof module.createHeartbeatQueue>) => ({
    ...module.createHeartbeatQueue(...args), resumeQueuedRunsAfterDrain: hooks.queue,
  }) };
});
vi.mock("../native-runtime/index.js", async original => ({
  ...await original<typeof import("../native-runtime/index.js")>(),
  dispatchNativeSessionResumptions: hooks.resume,
}));

describe("native deadline drain and resume", () => {
  let heartbeat: ReturnType<typeof heartbeatService>;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    stopTaskDrain();
    const db = new Proxy({}, { get: () => { throw new Error("Unexpected deadline database access"); } }) as Db;
    heartbeat = heartbeatService(db, { runtimeEnv: {} });
  });
  afterEach(async () => {
    stopTaskDrain();
    await heartbeat?.resumeQueuedRunsAfterDrain();
    await vi.runOnlyPendingTimersAsync();
    await heartbeat?.drainActiveRunExecutions();
    vi.useRealTimers();
  });

  it.each([undefined, "restart"] as const)("retains an overdue %s wait through drain with its original dispatch mode", async mode => {
    const deadline = new Date(Date.now() + 100);
    startTaskDrain({});
    hooks.schedule!("waiting-run", deadline, mode);
    await vi.advanceTimersByTimeAsync(100);
    expect(hooks.restart).not.toHaveBeenCalled();
    expect(hooks.resume).not.toHaveBeenCalled();
    stopTaskDrain();
    await heartbeat.resumeQueuedRunsAfterDrain();
    await vi.advanceTimersByTimeAsync(0);
    const called = mode === "restart" ? hooks.restart : hooks.resume;
    const other = mode === "restart" ? hooks.resume : hooks.restart;
    expect(called).toHaveBeenCalledOnce();
    expect(other).not.toHaveBeenCalled();
    await heartbeat.resumeQueuedRunsAfterDrain();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(called).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves a future follow-up deadline when draining cancels its timer", async () => {
    const deadline = new Date(Date.now() + 100);
    hooks.schedule!("future-run", deadline);
    await heartbeat.drainActiveRunExecutions();
    await heartbeat.resumeQueuedRunsAfterDrain();
    await vi.advanceTimersByTimeAsync(99);
    expect(hooks.resume).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(hooks.resume).toHaveBeenCalledOnce();
    expect(hooks.restart).not.toHaveBeenCalled();
  });

  it("rearms the original owner when another service facade ends the drain", async () => {
    hooks.schedule!("other-facade-run", new Date(Date.now() + 100));
    const db = new Proxy({}, { get: () => { throw new Error("Unexpected replacement facade database access"); } }) as Db;
    const other = heartbeatService(db, { runtimeEnv: {} });
    await other.drainActiveRunExecutions();
    await vi.advanceTimersByTimeAsync(100);
    await other.resumeQueuedRunsAfterDrain();
    await vi.advanceTimersByTimeAsync(0);
    expect(hooks.resume).toHaveBeenCalledOnce();
    expect(hooks.restart).not.toHaveBeenCalled();
  });

  it("retries a failed follow-up obligation without changing its dispatch mode", async () => {
    hooks.resume.mockRejectedValueOnce(new Error("temporary database failure"));
    hooks.schedule!("failed-follow-up", new Date());
    await vi.advanceTimersByTimeAsync(0);
    expect(hooks.resume).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(hooks.resume).toHaveBeenCalledTimes(2);
    expect(hooks.restart).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
