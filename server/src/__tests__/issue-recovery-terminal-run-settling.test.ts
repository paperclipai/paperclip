import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { heartbeatRuns, issues } from "@paperclipai/db";
import { describeIssueRecovery, issueRecoveryFixture } from "./issue-recovery.test-fixture.js";

describeIssueRecovery("stranded-task check of a terminal latest run", () => {
  const state = issueRecoveryFixture({ meter: true });

  async function seed(run: Partial<typeof heartbeatRuns.$inferInsert>) {
    const f = await state.fixture();
    const issueId = randomUUID(), runId = randomUUID();
    await state.db.insert(issues).values({ id: issueId, companyId: f.companyId, title: "Checked task", status: "in_progress",
      assigneeAgentId: f.agentId });
    await state.db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, status: "failed",
      invocationSource: "manual", contextSnapshot: { issueId }, finishedAt: new Date(Date.now() - 60_000), errorCode: "process_lost",
      ...run });
    return { ...f, issueId, runId };
  }

  async function leaseReads(f: { companyId: string; issueId: string }) {
    state.meter.startLog();
    await state.heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issueId,
      skipExternalConversationSettlement: true, skipRelatedRecovery: true });
    return state.meter.stopLog().filter(entry => /^select "controller_lease_expires_at" from "heartbeat_runs"/.test(entry.sql.trim()));
  }

  it("does not read the controller lease of a native latest run, which can never still be settling", async () => {
    const f = await seed({ runtimeMode: "native", controllerBootId: randomUUID(),
      controllerLeaseExpiresAt: new Date(Date.now() + 60_000) });
    expect(await leaseReads(f)).toEqual([]);
  }, 120_000);

  it("still reads the unexpired controller lease of a legacy run another server is settling", async () => {
    const f = await seed({ runtimeMode: "legacy", controllerBootId: randomUUID(),
      controllerLeaseExpiresAt: new Date(Date.now() + 60_000) });
    expect(await leaseReads(f)).toHaveLength(1);
  }, 120_000);
});
