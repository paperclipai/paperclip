import { expect, it, vi } from "vitest";
import { installDatabaseWorkSignals, subscribeDatabaseWork } from "../../../packages/db/src/work-signals.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { notifyExecutionRunWork, writeExecutionControl } from "../services/execution-control-notifications.js";

it.each([false, true])("keeps execution queue consumers intact and emits only a known status-card company scope (%s)", async scoped => {
  const owner = installDatabaseWorkSignals({ execute: vi.fn(async () => []), transaction: async (fn: (tx: object) => Promise<unknown>) =>
    fn({ execute: async () => [{ xid: "1" }] }) });
  const queues = [DELIVERY_QUEUES.executionStatus, DELIVERY_QUEUES.executionFinalization, DELIVERY_QUEUES.executionReplacement,
    DELIVERY_QUEUES.executionDisposition, DELIVERY_QUEUES.issueMonitors];
  const settled: Array<{ queue: string; hints?: string[] }> = [];
  const unsubscribe = [...queues, DELIVERY_QUEUES.statusCardEvaluation, DELIVERY_QUEUES.workspaceRecovery].map(queue => subscribeDatabaseWork(owner, queue, (event, hints) => {
    if (event === "settled") settled.push({ queue, hints: hints ? [...hints] : undefined });
  }));
  try {
    const scope = scoped ? { companyId: "changed-company", runId: "changed-run" } : undefined;
    await owner.transaction(async tx => {
      await notifyExecutionRunWork(tx, scope);
      expect(settled).toEqual([]);
    });
    expect(new Set(settled.map(row => row.queue))).toEqual(new Set([...queues, ...(scoped ? [DELIVERY_QUEUES.statusCardEvaluation] : [])]));
    expect(settled.find(row => row.queue === DELIVERY_QUEUES.statusCardEvaluation)?.hints)
      .toEqual(scoped ? ["changes:changed-company"] : undefined);
    settled.length = 0;
    const write = vi.fn(async () => "written");
    expect(await writeExecutionControl(owner as never, DELIVERY_QUEUES.workspaceRecovery, write, scope)).toBe("written");
    expect(write).toHaveBeenCalledOnce();
    expect(new Set(settled.map(row => row.queue))).toEqual(new Set([DELIVERY_QUEUES.issueMonitors, DELIVERY_QUEUES.workspaceRecovery,
      ...(scoped ? [DELIVERY_QUEUES.statusCardEvaluation] : [])]));
  } finally { for (const stop of unsubscribe) stop(); }
});
