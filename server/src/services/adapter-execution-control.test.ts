import { afterEach, expect, it, vi } from "vitest";
import { AdapterStopTimeoutError } from "./adapter-stop-timeout.js";
import {
  adapterExecutionControls,
  captureAdapterStopOwnership,
  createAdapterExecutionControl,
  registerAdapterExecutionControl,
  waitForAdapterStop,
} from "./adapter-execution-control.js";

afterEach(() => vi.useRealTimers());

async function stopTimeout(pending: Promise<void>): Promise<AdapterStopTimeoutError> {
  try {
    await pending;
  } catch (error) {
    expect(error).toBeInstanceOf(AdapterStopTimeoutError);
    return error as AdapterStopTimeoutError;
  }
  throw new Error("Stop unexpectedly settled");
}

it("holds readiness for every exact-run no-owner Stop and releases owners idempotently", async () => {
  const runId = "registration-after-two-stops";
  const first = captureAdapterStopOwnership(runId);
  const second = captureAdapterStopOwnership(runId);
  const control = createAdapterExecutionControl();
  const registration = registerAdapterExecutionControl(runId, control);
  try {
    expect(first.control).toBeUndefined();
    expect(second.control).toBeUndefined();
    expect(adapterExecutionControls.has(runId)).toBe(false);
    first.release();
    first.release();
    await Promise.resolve();
    expect(adapterExecutionControls.has(runId)).toBe(false);
    second.release();
    await registration;
    expect(adapterExecutionControls.get(runId)).toBe(control);
  } finally {
    first.release();
    second.release();
    await registration;
    adapterExecutionControls.delete(runId);
  }
});

it("waits for a later no-owner Stop added while readiness is already waiting", async () => {
  const runId = "registration-overlapping-stops";
  const first = captureAdapterStopOwnership(runId);
  const control = createAdapterExecutionControl();
  const registration = registerAdapterExecutionControl(runId, control);
  const later = captureAdapterStopOwnership(runId);
  try {
    first.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(adapterExecutionControls.has(runId)).toBe(false);
    later.release();
    await registration;
    expect(adapterExecutionControls.get(runId)).toBe(control);
  } finally {
    first.release();
    later.release();
    await registration;
    adapterExecutionControls.delete(runId);
  }
});

it("captures a registered owner without blocking its own readiness or another run", async () => {
  const runId = "registration-before-stop";
  const unrelated = captureAdapterStopOwnership("unrelated-stop");
  const control = createAdapterExecutionControl();
  try {
    await registerAdapterExecutionControl(runId, control);
    const stop = captureAdapterStopOwnership(runId);
    expect(stop.control).toBe(control);
    stop.release();
    expect(adapterExecutionControls.get(runId)).toBe(control);
  } finally {
    unrelated.release();
    adapterExecutionControls.delete(runId);
  }
});

it("releases a failed no-owner Stop without inventing cancellation or stranding readiness", async () => {
  const runId = "registration-after-failed-stop";
  const stop = captureAdapterStopOwnership(runId);
  const control = createAdapterExecutionControl();
  const registration = registerAdapterExecutionControl(runId, control);
  const failure = new Error("cancellation write failed");
  try {
    await expect(
      (async () => {
        try {
          throw failure;
        } finally {
          stop.release();
        }
      })(),
    ).rejects.toBe(failure);
    await registration;
    expect(control.controller.signal.aborted).toBe(false);
    expect(adapterExecutionControls.get(runId)).toBe(control);
  } finally {
    stop.release();
    await registration;
    adapterExecutionControls.delete(runId);
  }
});

it("does not acknowledge abort until execution and cleanup settle", async () => {
  const control = createAdapterExecutionControl();
  const finished = vi.fn();
  const waiting = waitForAdapterStop(control.settled).then(finished);
  control.controller.abort();
  await Promise.resolve();
  expect(finished).not.toHaveBeenCalled();
  control.finish();
  await waiting;
  expect(finished).toHaveBeenCalledOnce();
});

it("bounds Stop when an adapter does not settle", async () => {
  vi.useFakeTimers();
  const control = createAdapterExecutionControl();
  const assertion = expect(
    waitForAdapterStop(control.settled, 1000),
  ).rejects.toThrow("termination has not been verified");
  await vi.advanceTimersByTimeAsync(1000);
  await assertion;
  expect(vi.getTimerCount()).toBe(0);
});

it("records the exact unconfirmed run without finishing or removing its control", async () => {
  vi.useFakeTimers();
  const runId = "11111111-1111-4111-8111-111111111111";
  const control = createAdapterExecutionControl();
  await registerAdapterExecutionControl(runId, control);
  control.controller.abort();
  let finished = false;
  void control.settled.then(() => { finished = true; });
  const result = waitForAdapterStop(control.settled, 1000, {
    runId, adapterType: "claude_local", runtimeMode: "legacy", abortRequested: control.controller.signal.aborted,
  }).catch((error: unknown) => error);
  try {
    await vi.advanceTimersByTimeAsync(1000);
    const error = await result;
    expect(error).toBeInstanceOf(AdapterStopTimeoutError);
    expect((error as AdapterStopTimeoutError).diagnostics).toEqual({
      runId, adapterType: "claude_local", runtimeMode: "legacy", abortRequested: true, timeoutMs: 1000,
      phase: "unknown", phaseElapsedMs: null,
    });
    expect(adapterExecutionControls.get(runId)).toBe(control);
    expect(finished).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    control.finish();
    await control.settled;
    expect(finished).toBe(true);
  } finally {
    control.finish();
    adapterExecutionControls.delete(runId);
  }
});

it("samples the pending phase at each Stop timeout without settling the executor", async () => {
  vi.useFakeTimers();
  const runId = "11111111-1111-4111-8111-111111111111";
  const control = createAdapterExecutionControl();
  await registerAdapterExecutionControl(runId, control);
  const read = vi.spyOn(control.phases, "snapshot");
  const pending = stopTimeout(waitForAdapterStop(control.settled, 1000, { runId }, control));
  expect(read).not.toHaveBeenCalled();
  control.phases.enter("instruction_collection");
  await vi.advanceTimersByTimeAsync(1000);
  const first = await pending;
  expect(first.diagnostics).toMatchObject({ phase: "instruction_collection", phaseElapsedMs: expect.any(Number) });
  const secondWait = stopTimeout(waitForAdapterStop(control.settled, 1000, { runId }, control));
  control.phases.enter("lease_release");
  await vi.advanceTimersByTimeAsync(1000);
  expect((await secondWait).diagnostics.phase).toBe("lease_release");
  expect(first.diagnostics.phase).toBe("instruction_collection");
  expect(Object.isFrozen(first.diagnostics)).toBe(true);
  expect(adapterExecutionControls.get(runId)).toBe(control);
  control.finish();
  adapterExecutionControls.delete(runId);
});

it.each(["replaced", "wrong_run", "wrong_promise", "throwing_reader"])("omits pending phase for a %s control", async (scenario) => {
  vi.useFakeTimers();
  const runId = "11111111-1111-4111-8111-111111111111";
  const owner = createAdapterExecutionControl();
  const other = createAdapterExecutionControl();
  await registerAdapterExecutionControl(runId, owner);
  owner.phases.enter("instruction_collection");
  const pending = stopTimeout(waitForAdapterStop(scenario === "wrong_promise" ? other.settled : owner.settled, 1000,
    { runId: scenario === "wrong_run" ? "22222222-2222-4222-8222-222222222222" : runId }, owner));
  if (scenario === "replaced") await registerAdapterExecutionControl(runId, other);
  if (scenario === "throwing_reader") vi.spyOn(owner.phases, "snapshot").mockImplementation(() => { throw new Error("private fixture payload"); });
  await vi.advanceTimersByTimeAsync(1000);
  expect((await pending).diagnostics).toMatchObject({ phase: "unknown", phaseElapsedMs: null });
  expect(JSON.stringify((await pending).diagnostics)).not.toContain("private fixture payload");
  owner.finish();
  other.finish();
  adapterExecutionControls.delete(runId);
});
