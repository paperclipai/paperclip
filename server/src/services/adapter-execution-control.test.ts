import { afterEach, expect, it, vi } from "vitest";
import { createAdapterExecutionControl, waitForAdapterStop } from "./adapter-execution-control.js";

afterEach(() => vi.useRealTimers());

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
  const assertion = expect(waitForAdapterStop(control.settled, 1000)).rejects.toThrow("termination has not been verified");
  await vi.advanceTimersByTimeAsync(1000);
  await assertion;
  expect(vi.getTimerCount()).toBe(0);
});

