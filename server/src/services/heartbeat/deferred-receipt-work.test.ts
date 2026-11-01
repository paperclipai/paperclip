import { afterEach, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import { registerDeferredReceiptWork } from "./deferred-receipt-work.js";

afterEach(() => vi.useRealTimers());

it.each(["skipped", "budget_pause", "operator_pause", "issue_tree_hold_active"])("keeps recovery scheduled until admission settles or changes to %s", async outcome => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = Date.now();
  const row = {
    id: "receipt", companyId: "company", status: "deferred_issue_execution",
    updatedAt: new Date(start), claimedAt: null, error: null,
    payload: { executionWait: { recoveryActionId: null, reason: "execution_recovery" } },
    delayed: true, interruptedLegacy: false,
    readmissionEligible: true,
  };
  // Exercise the real registered deadline worker, including its retained entries.
  const query = {
    from: () => query, where: () => query, orderBy: () => query,
    limit: async () => [row],
    then: (resolve: (rows: typeof row[]) => unknown) => Promise.resolve([row]).then(resolve),
  };
  const db = { select: () => query } as unknown as Db;
  type Coordinator = ReturnType<typeof createDeliveryWorkCoordinator>;
  type Task = Parameters<Coordinator["register"]>[1];
  const tasks = new Map<string, Task>();
  const coordinator = { register(queue: string, task: Task) {
    tasks.set(queue, task);
    return { ready: Promise.resolve(), wake() {}, async stop() {} };
  } } as unknown as Coordinator;
  let gateHeld = true;
  const resume = vi.fn(async () => {
    row.updatedAt = new Date(Date.now());
    if (!gateHeld) {
      if (outcome === "skipped") row.status = "skipped";
      else row.payload.executionWait.reason = outcome;
    }
  });
  const workers = registerDeferredReceiptWork(db, coordinator, {
    resume, settleTaskChat: vi.fn(), createNativeBatch: () => vi.fn(),
    schedulingSuppressed: async () => false,
  }, () => true);
  await workers.ready;
  const task = tasks.get(DELIVERY_QUEUES.deferredExecutionReceipts)!;
  const pass = () => task.run(new AbortController().signal);
  await pass();
  expect(task.nextRunAt?.()).toBe(start + 60_000);
  vi.setSystemTime(start + 30_000);
  await pass();
  expect(resume).not.toHaveBeenCalled();
  expect(task.nextRunAt?.()).toBe(start + 60_000);
  vi.setSystemTime(start + 60_000);
  await pass();
  expect(resume).toHaveBeenCalledOnce();
  expect(task.nextRunAt?.()).toBe(start + 120_000);
  gateHeld = false;
  vi.setSystemTime(start + 120_000);
  await pass();
  expect(resume).toHaveBeenCalledTimes(2);
  expect(resume).toHaveBeenLastCalledWith(expect.objectContaining({ companyId: "company", requestId: "receipt" }));
  expect(row.status).toBe(outcome === "skipped" ? "skipped" : "deferred_issue_execution");
  expect(task.nextRunAt?.()).toBeNull();
  vi.setSystemTime(start + 240_000);
  await pass();
  expect(resume).toHaveBeenCalledTimes(2);
  await workers.stop();
});
