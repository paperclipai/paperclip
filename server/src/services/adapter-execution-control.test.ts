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
