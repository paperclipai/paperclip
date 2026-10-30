import { installDatabaseWorkSignals } from "../../../packages/db/src/work-signals.js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerDeadlineWork } from "../services/deadline-work.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";

let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
afterEach(async () => { await coordinator?.stop(); vi.useRealTimers(); });

it.each([
  { due: "overdue", spacing: 0, delay: 250 },
  { due: "overdue", spacing: 1_000, delay: 1_000 },
  { due: "future", spacing: 0, delay: 5 },
  { due: "future", spacing: 1_000, delay: 1_000 },
])("preserves $due continuation with $spacing ms minimum spacing and disarms after settlement", async ({ due, spacing, delay }) => {
  vi.useFakeTimers();
  const onError = vi.fn();
  const owner = installDatabaseWorkSignals({ execute: vi.fn(async () => []) });
  coordinator = createDeliveryWorkCoordinator({ owner, canRun: () => true, onError });
  const now = Date.now();
  const run = vi.fn(async () => {});
  const worker = registerDeadlineWork(coordinator, DELIVERY_QUEUES.agentTimers, {
    run,
    next: async () => run.mock.calls.length === 1 ? now + (due === "future" ? 5 : -1) : null,
    canRun: () => true,
    retryMs: 30_000,
    continuationMs: 250,
    minimumSpacingMs: spacing,
  });
  await worker.ready;
  expect(run).toHaveBeenCalledOnce();
  expect(coordinator.nextWakeAt()).toBe(now + delay);
  await vi.advanceTimersByTimeAsync(delay - 1);
  expect(run).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledTimes(2);
  expect(coordinator.nextWakeAt()).toBeNull();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(run).toHaveBeenCalledTimes(2);
  expect(onError).not.toHaveBeenCalled();
});
