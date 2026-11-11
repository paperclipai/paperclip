import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { legacyExecutionNeedsReconciliationWithEvidence, terminalizeLegacyExecution } from "../services/legacy-execution-recovery.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeWithDatabase = support.supported ? describe : describe.skip;

describeWithDatabase("discarded queued-message recovery", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("discarded-message-recovery-");
    db = createDb(temporary.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temporary?.cleanup(); });
  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Recovery fixture", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "claude_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Conversation", status: "in_review", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "queued", runtimeMode: "legacy", contextSnapshot: { issueId } });
    const actions = () => db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, companyId));
    return { companyId, agentId, issueId, runId, actions };
  }
  it("does not create reconciliation for a discarded queued message", async () => {
    const f = await fixture();
    const [run] = await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(),
      errorCode: "queued_comment_discarded", resultJson: null }).where(eq(heartbeatRuns.id, f.runId)).returning();
    await terminalizeLegacyExecution({ db, run, status: "cancelled", fromStatuses: ["cancelled"], reconcileIfNeeded: true });
    expect(await f.actions()).toHaveLength(0);
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, run)).toBe(false);
  });
  it("excludes historical discarded-message holds only without retained execution evidence", async () => {
    const f = await fixture();
    const [run] = await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(),
      errorCode: "queued_comment_discarded", resultJson: null }).where(eq(heartbeatRuns.id, f.runId)).returning();
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", ownerType: "board",
      fingerprint: `legacy-execution:${run.id}`, status: "resolved", outcome: "blocked", nextAction: "Reconcile",
      evidence: { runId: run.id, automaticRecovery: { replay: "blocked" } } });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    for (const patch of [{ startedAt: new Date() }, { processPid: 123456789 },
      { sessionIdAfter: "provider-session" }, { runnerProfileJson: { sessionCheckpoint: { retained: true } } },
      { resultJson: { workspaceRestoreFailure: "restore_unsafe_archive" } }]) {
      const changed = { ...run, ...patch };
      await db.update(heartbeatRuns).set(changed).where(eq(heartbeatRuns.id, run.id));
      expect(await legacyExecutionNeedsReconciliationWithEvidence(db, changed)).toBe(true);
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
    }
    await db.update(heartbeatRuns).set(run).where(eq(heartbeatRuns.id, run.id));
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, runId: run.id, agentId: f.agentId,
      seq: 1, eventType: "adapter.invoke" });
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, run)).toBe(true);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
  });
});
