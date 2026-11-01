import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests, agents, companies, createDb, environmentLeases,
  heartbeatRunEvents, heartbeatRuns, issueComments, issueRecoveryActions, issues, issueTreeHoldMembers, issueTreeHolds,
  nativeRunFinalizations,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { heartbeatService } from "../services/heartbeat.js";
import { legacyExecutionNeedsReconciliationWithEvidence, terminalizeLegacyExecution } from "../services/legacy-execution-recovery.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("undispatched execution waits", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("undispatched-execution-wait-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });

  async function seed(withHistoricalHold = false) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const runId = randomUUID(), actionId = randomUUID(), originalActionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Admission wait", defaultResponsibleUserId: "board", issuePrefix: "W" + companyId.replaceAll("-", "") });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", adapterType: "paperclip_runner", status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue saved work", status: "todo", assigneeAgentId: agentId });
    const [run] = await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, runtimeMode: "legacy", status: "cancelled",
      errorCode: "execution_reconciliation_required", finishedAt: new Date(Date.now() - 60_000),
      contextSnapshot: { issueId, taskId: issueId },
      resultJson: { stopReason: "execution_reconciliation_required", timeoutSource: "stale_queued_run_gate",
        timeoutFired: false, timeoutConfigured: false, effectiveTimeoutSec: 0,
        executionWait: { issueId, recoveryActionId: originalActionId } },
    }).returning();
    if (withHistoricalHold) await db.insert(issueRecoveryActions).values({
      id: actionId, companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      cause: "legacy_execution_requires_reconciliation", fingerprint: "legacy-execution:" + runId,
      status: "resolved", outcome: "blocked", ownerType: "board", nextAction: "Inspect the stopped work.",
      evidence: { runId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
    });
    return { companyId, agentId, issueId, runId, actionId, originalActionId, run };
  }

  async function saveMessages(f: Awaited<ReturnType<typeof seed>>) {
    // Occupy the agent so admission cannot launch a provider in this test.
    const [busy] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" }).returning();
    const commentIds = [randomUUID(), randomUUID()];
    await db.insert(issueComments).values(commentIds.map((id, index) => ({ id, companyId: f.companyId,
      issueId: f.issueId, authorType: "user", authorUserId: index ? "second-user" : "board",
      body: index ? "Preserve the recovered files." : "Continue the original work.",
      createdAt: new Date(Date.now() - 20_000 + index) })));
    const queueId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId: f.companyId, agentId: f.agentId,
      source: "automation", reason: "issue_commented", status: "deferred_issue_execution",
      requestedByActorType: "user", requestedByActorId: "board", payload: { issueId: f.issueId,
        commentId: commentIds[1], _paperclipWakeContext: { issueId: f.issueId, wakeReason: "issue_commented",
          wakeCommentId: commentIds[1], wakeCommentIds: commentIds } } });
    return { commentIds, queueId, busy };
  }

  it("does not create another provider recovery incident for an admission denial", async () => {
    const f = await seed();
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, f.run)).toBe(false);
    await terminalizeLegacyExecution({ db, run: f.run, status: "cancelled", reconcileIfNeeded: true });
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId))).toHaveLength(0);
  });

  it("recognizes a historical false hold without deleting its audit history", async () => {
    const f = await seed(true);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId)))[0])
      .toMatchObject({ status: "resolved", outcome: "blocked", evidence: { automaticRecovery: { replay: "blocked" } } });
  });

  it("resumes all saved messages once through normal admission after restart", async () => {
    const f = await seed(true);
    const { commentIds, queueId } = await saveMessages(f);
    await Promise.all([heartbeatService(db).resumeQueuedRuns(), heartbeatService(db).resumeQueuedRuns()]);
    const successors = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
    expect(successors).toHaveLength(1);
    expect(successors[0].contextSnapshot).toMatchObject({ issueId: f.issueId, wakeCommentIds: commentIds });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queueId)))[0])
      .toMatchObject({ status: "queued", runId: successors[0].id });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
  });

  it.each(["pause", "daily_limit", "reassigned", "agent_paused", "company_inactive"])(
    "still honors %s during automatic admission", async gate => {
      const f = await seed(true);
      const { busy } = await saveMessages(f);
      if (gate === "pause") {
        const holdId = randomUUID();
        await db.insert(issueTreeHolds).values({ id: holdId, companyId: f.companyId, rootIssueId: f.issueId, mode: "pause", status: "active" });
        await db.insert(issueTreeHoldMembers).values({ companyId: f.companyId, holdId, issueId: f.issueId, depth: 0, issueTitle: "Continue saved work", issueStatus: "todo" });
      } else if (gate === "daily_limit") {
        await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1, maxDailyRuns: 0 } } }).where(eq(agents.id, f.agentId));
      } else if (gate === "company_inactive") {
        await db.update(companies).set({ status: "paused" }).where(eq(companies.id, f.companyId));
      } else if (gate === "agent_paused") {
        await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
      } else {
        await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.issueId));
      }
      await heartbeatService(db).resumeQueuedRuns();
      if (gate === "daily_limit") {
        // This cap is rechecked at dispatch, after ordinary deferred promotion.
        await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busy.id));
        await heartbeatService(db).resumeQueuedRunsForAgent(f.companyId, f.agentId);
        const attempts = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
        expect(attempts.filter(run => run.id !== f.runId && run.id !== busy.id))
          .toEqual([expect.objectContaining({ status: "cancelled", startedAt: null, errorCode: "heartbeat.daily_run_limit" })]);
      }
      expect(await db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")))).toHaveLength(0);
    },
  );

  it.each(["foreign_run", "wrong_issue", "malformed_run", "workspace"])(
    "retains historical actions with %s evidence", async kind => {
      const f = await seed(true);
      let issueId = f.issueId;
      if (kind === "wrong_issue") {
        issueId = randomUUID();
        await db.insert(issues).values({ id: issueId, companyId: f.companyId, title: "Different source", status: "todo", assigneeAgentId: f.agentId });
        await db.update(issueRecoveryActions).set({ sourceIssueId: issueId }).where(eq(issueRecoveryActions.id, f.actionId));
      } else {
        const evidence = { runId: kind === "foreign_run" ? (await seed()).runId : kind === "malformed_run" ? "invalid-uuid" : f.runId,
          automaticRecovery: { replay: "blocked" }, ...(kind === "workspace" ? { workspaceRestoreFailure: "restore_unsafe_archive" } : {}) };
        await db.update(issueRecoveryActions).set({ evidence }).where(eq(issueRecoveryActions.id, f.actionId));
      }
      expect(await getExecutionBlocker(db, f.companyId, issueId)).toMatchObject({ recoveryActionId: f.actionId });
    },
  );

  it("keeps the real upstream workspace obligation effective", async () => {
    const f = await seed(true), sourceId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: sourceId, companyId: f.companyId, agentId: f.agentId,
      runtimeMode: "native", nativeIssueId: f.issueId, status: "failed", startedAt: new Date(), finishedAt: new Date(),
      contextSnapshot: { issueId: f.issueId }, resultJson: { workspaceRestoreFailure: "restore_unsafe_archive" } });
    await db.insert(issueRecoveryActions).values({ id: f.originalActionId, companyId: f.companyId,
      sourceIssueId: f.issueId, kind: "active_run_watchdog", cause: "native_continuation_requires_reconciliation",
      fingerprint: sourceId, status: "resolved", outcome: "blocked", ownerType: "board",
      evidence: { runId: sourceId, workspaceRestoreFailure: "restore_unsafe_archive", automaticRecovery: { replay: "blocked" } },
      nextAction: "Recover the saved files before continuing." });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({
      recoveryActionId: f.originalActionId, workspaceRepairRequired: true,
    });
  });

  it.each(["started", "runtime_selected", "process", "session", "controller", "stage", "receipt", "receipt_issue", "receipt_action", "lease", "coordinator", "launch", "provider", "workspace"])(
    "retains a hold with conflicting or incomplete %s evidence", async kind => {
      const f = await seed(true);
      const patch = kind === "started" ? { startedAt: new Date() }
        : kind === "runtime_selected" ? { runtimeModeResolvedAt: new Date() }
        : kind === "process" ? { processPid: 999999999 }
        : kind === "session" ? { nativeSessionId: randomUUID() }
        : kind === "controller" ? { controllerBootId: randomUUID() }
        : kind === "coordinator" ? { nativeIssueId: f.issueId }
        : kind === "stage" ? { executionStage: "dispatching" }
        : kind === "receipt" ? { resultJson: { stopReason: "execution_reconciliation_required" } }
        : kind === "receipt_issue" ? { resultJson: { ...f.run.resultJson, executionWait: { issueId: randomUUID(), recoveryActionId: f.originalActionId } } }
        : kind === "receipt_action" ? { resultJson: { ...f.run.resultJson, executionWait: { issueId: f.issueId, recoveryActionId: "invalid-uuid" } } }
        : kind === "workspace" ? { resultJson: { ...f.run.resultJson, workspaceRestoreFailure: "restore_unsafe_archive" } } : {};
      const run = Object.keys(patch).length
        ? (await db.update(heartbeatRuns).set(patch).where(eq(heartbeatRuns.id, f.runId)).returning())[0]
        : f.run;
      if (kind === "lease") await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.runId,
        provider: "local", status: "released", releasedAt: new Date(), cleanupStatus: "succeeded" });
      if (kind === "coordinator") await db.insert(nativeRunFinalizations).values({ companyId: f.companyId,
        issueId: f.issueId, runId: f.runId, phase: "observed" });
      if (kind === "launch" || kind === "provider") await db.insert(heartbeatRunEvents).values({
        companyId: f.companyId, agentId: f.agentId, runId: f.runId, seq: 1,
        eventType: kind === "launch" ? "native.process_start_requested" : "provider.event", stream: "system" });
      expect(await legacyExecutionNeedsReconciliationWithEvidence(db, run)).toBe(true);
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ recoveryActionId: f.actionId });
    },
  );
});
