import { describe, expect, it, vi } from "vitest";
import { createDb } from "@paperclipai/db";
import { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { registerRunDispatchWork } from "./dispatch-work.js";
import type { UndispatchedQueuedRun } from "../queued-run-dispatch-liveness.js";

describe("queued-run dispatch re-drive", () => {
  it("keeps the companies to re-read when the undispatched-run read fails, and re-drives after the retry", async () => {
    const owner = createDb("postgres://paperclip:unused@127.0.0.1:1/unused", { maxConnections: 1 });
    const stranded: UndispatchedQueuedRun = { runId: "run-1", companyId: "company-1", agentId: "agent-1", issueId: null,
      createdAt: new Date(Date.now() - 10 * 60_000) };
    const reads: Array<string | undefined> = [];
    const list = vi.fn(async (scope?: { companyId: string }) => {
      reads.push(scope?.companyId);
      if (reads.length === 1) throw new Error("transient read failure");
      return [stranded];
    });
    const resumed: Array<string | undefined> = [];
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner, canRun: () => true, onError: error => errors.push(error) });
    try {
      await registerRunDispatchWork(coordinator, {
        promoteDueScheduledRetries: async () => undefined,
        nextScheduledRetryAt: async () => null,
        schedulingSuppressed: async () => false,
        resumeQueuedRunsAfterDrain: async scope => { resumed.push(scope?.companyId); },
        listUndispatchedQueuedRuns: list,
      }, () => true).ready;
      await expect.poll(() => resumed, { timeout: 45_000, interval: 250 }).toContain("company-1");
      expect(reads.slice(0, 2)).toEqual([undefined, undefined]);
      expect(errors).toEqual([expect.objectContaining({ message: "transient read failure" })]);
    } finally {
      await coordinator.stop();
      await owner.$client.end({ timeout: 1 });
    }
  }, 60_000);
});
