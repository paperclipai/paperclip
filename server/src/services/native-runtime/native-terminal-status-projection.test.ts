import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, completionContracts, createDb, heartbeatRuns, issues,
  nativeRunFinalizations, nativeRunResults } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { deliverExecutionStatuses } from "../execution-status-delivery.js";
import { buildIssueMonitorTriggeredPatch, normalizeIssueExecutionPolicy } from "../issue-execution-policy.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("native terminal status projection", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-terminal-status-");
    db = createDb(temporary.connectionString);
  });
  afterAll(async () => { await temporary?.cleanup(); });

  async function fixture() {
    await deliverExecutionStatuses(db, { publish: vi.fn() });
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const contractId = randomUUID(), resultId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Monitor status", issuePrefix: `S${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner", status: "active" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Saved check", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId,
      runtimeMode: "native", status: "running", contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const authority = new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId });
    await authority.execute({ tool: "set_task_monitor", callId: randomUUID(), arguments: {
      idempotencyKey: "saved-monitor", monitor: { nextCheckAt: new Date(Date.now() + 60_000).toISOString(), notes: "Check the saved result." },
    } });
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "test", criteria: [] }, canonicalSha256: randomUUID(),
      createdByActorType: "system", createdByActorId: "test" });
    const accepted = { result: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "yielded",
      summary: "Wait for the saved check.", completionClaim: { contractRevision: "test", objectiveSatisfied: false,
        criteria: [], remainingWork: [{ description: "Check again", blocksCompletion: true }] },
      continuation: { kind: "monitor", summary: "Wait for the check", idempotencyKey: "provider-selected" },
      evidence: [], verification: [], attentionRequests: [], artifacts: [] },
      terminal: { schema: "paperclip.prp.terminal.v1", runTerminalState: "succeeded", turnTerminalState: "completed", reportedWorkDisposition: "yielded" } };
    const finishedAt = new Date("2020-01-01T00:00:00Z");
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt, completionContractId: contractId }).where(eq(heartbeatRuns.id, runId));
    await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId, completionContractId: contractId,
      serverFingerprint: randomUUID(), canonicalSha256: randomUUID(), schemaStatus: "accepted", resultJson: accepted });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "retryable_failure", resultId });
    const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
    await db.update(issues).set({ ...buildIssueMonitorTriggeredPatch({ issue: task!,
      policy: normalizeIssueExecutionPolicy(task!.executionPolicy), triggeredAt: new Date() }), executionRunId: null, checkoutRunId: null,
    }).where(eq(issues.id, issueId));
    const finalize = () => finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    const read = async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]!;
    return { runId, companyId, issueId, finishedAt, resultId, accepted, finalize, read };
  }

  it("preserves the original completion time while retrying an accepted monitor result", async () => {
    const f = await fixture();
    await f.finalize();
    expect((await f.read()).finishedAt).toEqual(f.finishedAt);
    await f.finalize();
    expect((await f.read()).finishedAt).toEqual(f.finishedAt);
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(coordinator).toMatchObject({ phase: "retryable_failure", failureCode: "monitor_wait_authority_lost", resultId: f.resultId });
    expect(coordinator.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.id, f.resultId)))[0].resultJson).toEqual(f.accepted);
  });

  it("retains an unacknowledged status delivery across unchanged finalization retries", async () => {
    const f = await fixture();
    await f.finalize();
    const before = await f.read();
    expect(before.executionStatusDeliveryId).toBeTruthy();
    await f.finalize();
    expect((await f.read()).executionStatusDeliveryId).toBe(before.executionStatusDeliveryId);
    const publish = vi.fn();
    await expect(deliverExecutionStatuses(db, { publish, failpoint: () => { throw new Error("after publish"); } })).rejects.toThrow("after publish");
    await f.finalize();
    expect((await f.read()).executionStatusDeliveryId).toBe(before.executionStatusDeliveryId);
    await deliverExecutionStatuses(db, { publish });
    const deliveries = publish.mock.calls.filter(([event]) => event.payload.runId === f.runId);
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0][0].payload.deliveryId).toBe(deliveries[1][0].payload.deliveryId);
  });

  it("preserves a pending status notification created by another producer", async () => {
    const f = await fixture();
    await f.finalize();
    const newer = randomUUID();
    await db.update(heartbeatRuns).set({ executionStatusDeliveryId: newer }).where(eq(heartbeatRuns.id, f.runId));
    await f.finalize();
    expect((await f.read()).executionStatusDeliveryId).toBe(newer);
  });

  it.each(["metadata", "status", "missing_completion_time"])("broadcasts a changed terminal projection after acknowledgement (%s)", async change => {
    const f = await fixture();
    await f.finalize();
    const publish = vi.fn();
    await deliverExecutionStatuses(db, { publish });
    if (change === "metadata") {
      await finalizeNativeRun({ db, runId: f.runId, workspaceFinalizeStatus: "failed", projectRunStatus: true });
      expect((await f.read()).resultJson?.workspaceFinalizeStatus).toBe("failed");
    } else {
      await db.update(heartbeatRuns).set(change === "status" ? { status: "failed" } : { finishedAt: null })
        .where(eq(heartbeatRuns.id, f.runId));
      await f.finalize();
      expect(await f.read()).toMatchObject({ status: "succeeded", finishedAt: expect.any(Date) });
    }
    await deliverExecutionStatuses(db, { publish });
    expect(publish.mock.calls.filter(([event]) => event.payload.runId === f.runId)).toHaveLength(2);
  });

  it("does not broadcast an unchanged terminal projection after acknowledgement or a new DB client", async () => {
    const f = await fixture();
    await f.finalize();
    const publish = vi.fn();
    await deliverExecutionStatuses(db, { publish });
    await f.finalize();
    await deliverExecutionStatuses(db, { publish });
    const reopened = createDb(temporary.connectionString);
    try {
      await finalizeNativeRun({ db: reopened, runId: f.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
      await deliverExecutionStatuses(reopened, { publish });
    } finally { await reopened.$client.end(); }
    expect(publish.mock.calls.filter(([event]) => event.payload.runId === f.runId)).toHaveLength(1);
    expect((await f.read()).executionStatusDeliveryId).toBeNull();
  });
});
