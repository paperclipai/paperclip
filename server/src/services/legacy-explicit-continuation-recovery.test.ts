import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, issueComments, issueRecoveryActions, issues } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { heartbeatService } from "./heartbeat.js";
import { terminalizeLegacyExecution } from "./legacy-execution-recovery.js";

describe("legacy recovery after an explicit user continuation", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("legacy-explicit-recovery-");
    db = createDb(temporary.connectionString);
  });
  afterAll(async () => { await temporary?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const sourceRunId = randomUUID(), commentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Legacy recovery race", issuePrefix: `L${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Conversational worker", role: "engineer",
      adapterType: "claude_local", status: "idle", runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue pending work", status: "blocked", assigneeAgentId: agentId });
    const [source] = await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId,
      status: "failed", runtimeMode: "legacy", processPid: 999999999, errorCode: "process_lost",
      error: "Server restarted during startup", contextSnapshot: { issueId },
      startedAt: new Date("2026-09-11T10:00:00Z"), finishedAt: new Date("2026-09-11T10:01:00Z") }).returning();
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: sourceRunId,
      status: "resolved", outcome: "blocked", nextAction: "Automatic recovery stopped.",
      evidence: { runId: sourceRunId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } });
    await db.insert(issueComments).values({ id: commentId, companyId, issueId, authorType: "user", authorUserId: "board",
      body: "Please continue the pending follow-up.", createdAt: new Date("2026-09-11T11:00:00Z") });
    // Keep the successor queued without mocking wake admission or launching a
    // provider, then replay the sweeper's already-read failed source explicitly.
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running" });
    const successor = await heartbeatService(db).wakeup(agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: "board",
      payload: { issueId, commentId }, contextSnapshot: { issueId, wakeCommentId: commentId },
    });
    expect(successor).toMatchObject({ status: "queued", contextSnapshot: { previousRunId: sourceRunId,
      explicitUserContinuation: { previousRunId: sourceRunId, commentId } } });
    expect(await getExecutionBlocker(db, companyId, issueId)).toBeNull();
    return { companyId, agentId, issueId, source: source!, successor: successor! };
  }

  it.each(["queued", "succeeded"])("does not recreate the retired source hold after the successor is %s", async status => {
    const f = await fixture();
    if (status === "succeeded") await db.update(heartbeatRuns).set({ status, finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.successor.id));
    const before = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));

    await terminalizeLegacyExecution({ db, run: f.source, status: "failed", fromStatuses: ["failed"] });

    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toEqual(before);
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.source.id));
    expect(source).toMatchObject({ status: "failed", resultJson: null, errorCode: "process_lost" });
    expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.id, f.successor.id))))
      .toMatchObject([{ status }]);
  });

  it("does not retire source recovery using a receipt bound to an unrelated task", async () => {
    const f = await fixture(), otherId = randomUUID();
    await db.insert(issues).values({ id: otherId, companyId: f.companyId, title: "Unrelated task", status: "todo", assigneeAgentId: f.agentId });
    const [unrelated] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "succeeded", runtimeMode: "legacy", contextSnapshot: { ...f.successor.contextSnapshot, issueId: otherId },
    }).returning();
    const [receipt] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    await db.update(issueRecoveryActions).set({ evidence: { ...receipt!.evidence, explicitUserContinuation: {
      ...(receipt!.evidence.explicitUserContinuation as Record<string, unknown>), runId: unrelated!.id,
    } } }).where(eq(issueRecoveryActions.id, receipt!.id));

    await terminalizeLegacyExecution({ db, run: f.source, status: "failed", fromStatuses: ["failed"] });

    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
  });

  it("keeps a newly reported workspace repair obligation despite the explicit turn receipt", async () => {
    const f = await fixture();
    await terminalizeLegacyExecution({ db, run: f.source, status: "failed", fromStatuses: ["failed"], patch: {
      resultJson: { workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: {
        schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [],
      } },
    } });

    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ workspaceRepairRequired: true });
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(actions.some(action => action.evidence.explicitUserContinuation)).toBe(true);
    expect(actions.some(action => action.evidence.workspaceRestoreFailure === "restore_failed")).toBe(true);
  });
});
