import { installDatabaseWorkSignals } from "../../../packages/db/src/work-signals.js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { registerScopedDeadlineWork } from "../services/scoped-deadline-work.js";

let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
afterEach(async () => { await coordinator?.stop(); vi.useRealTimers(); });

it("preserves a subsecond replacement deadline when the owner does not require pass spacing", async () => {
  vi.useFakeTimers();
  const onError = vi.fn();
  const owner = installDatabaseWorkSignals({ execute: vi.fn(async () => []) });
  coordinator = createDeliveryWorkCoordinator({ owner, canRun: () => true, onError });
  const now = Date.now();
  let dueAt = now + 60_000;
  const check = vi.fn(async () => null);
  const worker = registerScopedDeadlineWork(coordinator, {
    queue: DELIVERY_QUEUES.secretProposalExpiry,
    minimumPassIntervalMs: 0,
    decodeScope: hint => hint === "*" ? undefined : hint,
    matches: (entry, companyId?: string) => companyId === undefined || entry.companyId === companyId,
    load: async () => [{ id: "company", companyId: "company", dueAt }],
    check,
  }, () => true);
  await worker.ready;
  dueAt = now + 250;
  worker.invalidate("company");
  await vi.advanceTimersByTimeAsync(1);
  expect(coordinator.nextWakeAt()).toBe(dueAt);
  await vi.advanceTimersByTimeAsync(248);
  expect(check).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(check).toHaveBeenCalledOnce();
  expect(coordinator.nextWakeAt()).toBeNull();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(check).toHaveBeenCalledOnce();
  expect(onError).not.toHaveBeenCalled();
});


it("coalesces broad reconstruction without delaying an exact object hint or saved deadline", async () => {
  vi.useFakeTimers();
  const owner = installDatabaseWorkSignals({ execute: vi.fn(async () => []) });
  coordinator = createDeliveryWorkCoordinator({ owner, canRun: () => true, onError: vi.fn() });
  const now = Date.now();
  let dueAt = now + 60_000;
  const load = vi.fn(async () => [{ id: "object", companyId: "company", dueAt }]);
  const check = vi.fn(async () => null);
  const worker = registerScopedDeadlineWork(coordinator, {
    queue: DELIVERY_QUEUES.externalObjectRefresh,
    minimumPassIntervalMs: 0,
    reconstructionIntervalMs: (scope: string | undefined) => scope === "company" ? 30_000 : 0,
    decodeScope: hint => hint === "*" ? undefined : hint,
    matches: () => true,
    load,
    check,
  }, () => true);
  await worker.ready;
  worker.invalidate("company"); await vi.advanceTimersByTimeAsync(0);
  expect(load).toHaveBeenCalledTimes(2);
  worker.invalidate("company"); await vi.advanceTimersByTimeAsync(0);
  expect(load).toHaveBeenCalledTimes(2);
  expect(coordinator.nextWakeAt()).toBe(now + 30_000);
  dueAt = now + 250;
  worker.invalidate("object"); await vi.advanceTimersByTimeAsync(0);
  expect(load).toHaveBeenCalledTimes(3);
  expect(coordinator.nextWakeAt()).toBe(dueAt);
  await vi.advanceTimersByTimeAsync(250);
  expect(check).toHaveBeenCalledOnce();
  load.mockResolvedValue([]);
  await vi.advanceTimersByTimeAsync(29_750);
  expect(load).toHaveBeenCalledTimes(4);
  expect(coordinator.nextWakeAt()).toBeNull();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(load).toHaveBeenCalledTimes(4); expect(check).toHaveBeenCalledOnce();
});
