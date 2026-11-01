import type { Db } from "@paperclipai/db";
import { installDatabaseWorkSignals } from "../../../packages/db/src/work-signals.js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerProviderTraceRetentionWork } from "../services/provider-trace-retention-work.js";

const state = vi.hoisted(() => ({
  cleanup: vi.fn(async () => []),
  next: vi.fn<() => Promise<number | null>>(),
  probe: undefined as undefined | (() => string),
  unregister: vi.fn(),
}));
vi.mock("../services/provider-trace-store.js", () => ({
  providerTraceStore: () => ({ cleanupExpired: state.cleanup, nextRetentionDeadline: state.next }),
}));
vi.mock("../services/idle-local-work.js", () => ({
  registerIdleLocalWorkProbe: (probe: () => string) => {
    state.probe = probe;
    return state.unregister;
  },
}));
let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
afterEach(async () => {
  await coordinator?.stop();
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("reconstructs trace deadlines, stays quiet between obligations, and discharges the sleep blocker", async () => {
  vi.useFakeTimers();
  const owner = installDatabaseWorkSignals({ execute: vi.fn(async () => []) });
  const onError = vi.fn();
  coordinator = createDeliveryWorkCoordinator({ owner, canRun: () => true, onError });
  state.next.mockResolvedValue(null);
  const worker = registerProviderTraceRetentionWork(
    owner as unknown as Db,
    coordinator,
    () => true,
  );
  expect(state.probe!()).toBe("unknown");
  await worker.ready;
  expect(state.probe!()).toBe("none");
  expect(coordinator.nextWakeAt()).toBeNull();
  const initial = state.cleanup.mock.calls.length;
  await vi.advanceTimersByTimeAsync(300_000);
  expect(state.cleanup).toHaveBeenCalledTimes(initial);
  expect(state.next).toHaveBeenCalledOnce();

  const deadline = Date.now() + 60_000;
  state.next.mockResolvedValue(deadline);
  worker.wake();
  await vi.advanceTimersByTimeAsync(0);
  expect(state.probe!()).toBe("present");
  expect(coordinator.nextWakeAt()).toBe(deadline);
  const scheduled = state.cleanup.mock.calls.length;
  await vi.advanceTimersByTimeAsync(59_999);
  expect(state.cleanup).toHaveBeenCalledTimes(scheduled);
  state.next.mockResolvedValue(null);
  await vi.advanceTimersByTimeAsync(1);
  expect(state.cleanup).toHaveBeenCalledTimes(scheduled + 1);
  expect(state.probe!()).toBe("none");
  expect(coordinator.nextWakeAt()).toBeNull();
  await worker.stop();
  expect(state.unregister).toHaveBeenCalledOnce();
  expect(onError).not.toHaveBeenCalled();
});
