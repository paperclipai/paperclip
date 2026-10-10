import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, agentWakeupRequests, companies, createDb,
  environmentLeases, heartbeatRuns, issueRecoveryActions, issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.js";
import { LEGACY_WORKSPACE_RECOVERY_SCHEMA } from "../services/workspace-restore-recovery-state.js";

const external = process.env.PAPERCLIP_TEST_DATABASE_URL?.trim();
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("retained workspace repair route", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  beforeAll(async () => {
    if (external) db = createDb(external);
    else {
      temporary = await startEmbeddedPostgresTestDatabase("workspace-restore-repair-route-");
      db = createDb(temporary.connectionString);
    }
  }, 30_000);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function seed(options: { newerAction?: boolean; conversationReset?: boolean; noCurrentOwner?: boolean } = {}) {
    const companyId = randomUUID(), originalAgentId = randomUUID(), currentAgentId = randomUUID();
    const issueId = randomUUID(), sourceRunId = randomUUID(), currentRunId = randomUUID(), leaseId = randomUUID();
    const actionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Workspace repair API", issuePrefix: `W${companyId.slice(0, 7)}` });
    await db.insert(agents).values([
      { id: originalAgentId, companyId, name: "Original worker", role: "engineer", adapterType: "codex_local" },
      { id: currentAgentId, companyId, name: "Current worker", role: "engineer", adapterType: "codex_local" },
    ]);
    const ownerId = options.conversationReset ? originalAgentId : currentAgentId;
    await db.insert(issues).values({ id: issueId, companyId, title: "Preserve changed task", status: "in_progress",
      assigneeAgentId: options.noCurrentOwner ? null : ownerId,
      ...(options.conversationReset ? { conversationAgentId: originalAgentId, conversationUserId: "fixture-board",
        conversationState: "active", conversationSessionGeneration: 2 } : {}),
    });
    const workspaceRestoreRecovery = { schema: LEGACY_WORKSPACE_RECOVERY_SCHEMA, leaseIds: [leaseId] };
    await db.insert(heartbeatRuns).values([
      { id: sourceRunId, companyId, agentId: originalAgentId, runtimeMode: "legacy", status: "cancelled",
        finishedAt: new Date("2000-01-01T00:00:00Z"), contextSnapshot: { issueId, conversationSessionGeneration: 1 },
        runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } },
        resultJson: { workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery,
          conversationContinuation: "continue_conversation_v1" } },
      { id: currentRunId, companyId, agentId: ownerId, runtimeMode: "legacy", status: "running",
        contextSnapshot: { issueId, conversationSessionGeneration: 2 } },
    ]);
    await db.update(issues).set({ executionRunId: currentRunId, checkoutRunId: currentRunId,
      executionLockedAt: new Date("2000-01-01T00:00:00Z"), executionAgentNameKey: "current-worker" })
      .where(eq(issues.id, issueId));
    const identity = { id: leaseId, companyId, heartbeatRunId: sourceRunId, provider: "daytona", providerLeaseId: `fixture-${leaseId}` };
    await db.insert(environmentLeases).values({ ...identity, issueId, status: "released", leasePolicy: "retain_on_failure",
      releasedAt: new Date(), cleanupStatus: "success", metadata: {
        remoteExecutionTermination: remoteTerminationReceipt(identity, { providerLeaseId: identity.providerLeaseId, state: "stopped" }),
      } });
    await db.insert(issueRecoveryActions).values({ id: actionId, companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", ownerType: "board",
      returnOwnerAgentId: originalAgentId, fingerprint: `legacy-execution:${sourceRunId}`,
      status: "resolved", outcome: "blocked", nextAction: "Repair the retained workspace before continuing.",
      evidence: { runId: sourceRunId, workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery,
        automaticRecovery: { replay: "blocked" } },
    });
    const newerId = options.newerAction ? randomUUID() : null;
    if (newerId) await db.insert(issueRecoveryActions).values({ id: newerId, companyId, sourceIssueId: issueId,
      kind: "configuration_validation", cause: "configuration_incomplete", ownerType: "board", status: "active",
      fingerprint: `newer:${currentRunId}`, nextAction: "Review the current configuration.", evidence: { runId: currentRunId } });
    const [issueBefore] = await db.select().from(issues).where(eq(issues.id, issueId));
    const [leaseBefore] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
    const body = { actionId, outcome: "restored", sourceIssueStatus: issueBefore.status,
      executionReconciliation: { runId: sourceRunId, providerStopped: true, actionOutcome: "mixed",
        outcomeEvidence: "Reviewed the original action receipts without replaying any previous work.",
        workspaceRepairEvidence: "Recovered and verified the required files from the exact retained sandbox." } };
    return { companyId, issueId, sourceRunId, currentRunId, originalAgentId, currentAgentId, ownerId,
      leaseId, actionId, newerId, issueBefore, leaseBefore, body };
  }

  function appFor(actor: Record<string, unknown> = { type: "board", source: "local_implicit" }) {
    const wake = vi.fn(async () => null);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as unknown as { actor: unknown }).actor = actor; next(); });
    app.use("/api", issueRoutes(db, {} as Parameters<typeof issueRoutes>[1], { recoveryActionEnqueueWakeup: wake }));
    app.use(errorHandler);
    return { app, wake };
  }

  async function assertSourceUnchanged(f: Awaited<ReturnType<typeof seed>>) {
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toEqual(f.issueBefore);
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId)))[0]).toEqual(f.leaseBefore);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toEqual([]);
    expect(await db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.id, [f.sourceRunId, f.currentRunId]))).toHaveLength(2);
  }

  it.each(["reassigned", "conversation_reset", "unassigned"])("records board repair after %s without restarting or changing the current task", async scenario => {
    const f = await seed({ conversationReset: scenario === "conversation_reset", noCurrentOwner: scenario === "unassigned" });
    const { app, wake } = appFor();
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
    await request(app).post(`/api/issues/${f.issueId}/recovery-actions/resolve`).send(f.body).expect(200);
    await assertSourceUnchanged(f);
    expect(wake).not.toHaveBeenCalled();
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId));
    expect(action.evidence).toMatchObject({ workspaceRestoreRecovery: { leaseIds: [f.leaseId] },
      executionReconciliation: { runId: f.sourceRunId, workspaceRepairEvidence: f.body.executionReconciliation.workspaceRepairEvidence } });
    expect(action.evidence.automaticRecovery).toBeUndefined();
    expect(action.evidence.continuationDelivery).not.toBe("pending");
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    const auditBefore = await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId));
    expect(auditBefore.length).toBeGreaterThan(0);
    await request(app).post(`/api/issues/${f.issueId}/recovery-actions/resolve`).send(f.body).expect(200);
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId)))[0]).toEqual(action);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId))).toEqual(auditBefore);
    await assertSourceUnchanged(f);
    expect(wake).not.toHaveBeenCalled();
  });

  it.each(["blocked", "done", "cancelled", "backlog"])("records repair without changing the current %s task", async status => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.currentRunId));
    const [before] = await db.update(issues).set({ status, executionRunId: null, checkoutRunId: null,
      executionLockedAt: null, executionAgentNameKey: null }).where(eq(issues.id, f.issueId)).returning();
    const { app, wake } = appFor();
    await request(app).post(`/api/issues/${f.issueId}/recovery-actions/resolve`)
      .send({ ...f.body, sourceIssueStatus: status }).expect(200);
    await assertSourceUnchanged({ ...f, issueBefore: before });
    expect(wake).not.toHaveBeenCalled();
  });

  it("repairs only the recorded source while a newer active recovery action remains unchanged", async () => {
    const f = await seed({ newerAction: true });
    const [newerBefore] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.newerId!));
    const { app, wake } = appFor();
    const before = await request(app).get(`/api/issues/${f.issueId}/recovery-actions`).expect(200);
    expect(before.body.active).toMatchObject({ id: f.newerId });
    expect(before.body.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: f.actionId, evidence: expect.objectContaining({
        workspaceRestoreRecovery: { schema: LEGACY_WORKSPACE_RECOVERY_SCHEMA, leaseIds: [f.leaseId] },
      }) }), expect.objectContaining({ id: f.newerId }),
    ]));
    const response = await request(app).post(`/api/issues/${f.issueId}/recovery-actions/resolve`).send(f.body).expect(200);
    expect(response.body.issue.activeRecoveryAction).toMatchObject({ id: f.newerId });
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.newerId!)))[0]).toEqual(newerBefore);
    const repeated = await request(app).post(`/api/issues/${f.issueId}/recovery-actions/resolve`).send(f.body).expect(200);
    expect(repeated.body.issue.activeRecoveryAction).toMatchObject({ id: f.newerId });
    const after = await request(app).get(`/api/issues/${f.issueId}/recovery-actions`).expect(200);
    expect(after.body.active).toMatchObject({ id: f.newerId });
    expect(after.body.actions.map((action: { id: string }) => action.id)).toEqual([f.newerId]);
    await assertSourceUnchanged(f);
    expect(wake).not.toHaveBeenCalled();
  });

  it("rejects an agent even when it owns the current task and run", async () => {
    const f = await seed();
    const { app, wake } = appFor({ type: "agent", source: "agent_jwt", companyId: f.companyId,
      agentId: f.ownerId, runId: f.currentRunId });
    await request(app).post(`/api/issues/${f.issueId}/recovery-actions/resolve`).send(f.body).expect(403);
    await assertSourceUnchanged(f);
    expect(wake).not.toHaveBeenCalled();
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId)))[0].evidence)
      .not.toHaveProperty("executionReconciliation");
  });

  it("does not expose retained-source evidence to another company", async () => {
    const f = await seed(), other = await seed();
    const { app } = appFor({ type: "agent", source: "agent_jwt", companyId: other.companyId,
      agentId: other.ownerId, runId: other.currentRunId });
    const response = await request(app).get(`/api/issues/${f.issueId}/recovery-actions`).expect(404);
    expect(JSON.stringify(response.body)).not.toContain(f.leaseId);
    expect(JSON.stringify(response.body)).not.toContain(f.actionId);
  });

  it.each(["other_task", "other_company", "wrong_decision_run"])("rejects repair evidence for %s", async scenario => {
    const f = await seed();
    const other = await seed();
    const foreignTaskId = scenario === "other_task" ? randomUUID() : other.issueId;
    if (scenario === "other_task") await db.insert(issues).values({ id: foreignTaskId, companyId: f.companyId,
      title: "Other task", status: "todo", assigneeAgentId: f.originalAgentId });
    if (scenario !== "wrong_decision_run") await db.update(heartbeatRuns).set({
      ...(scenario === "other_company" ? { companyId: other.companyId, agentId: other.originalAgentId } : {}),
      contextSnapshot: { issueId: foreignTaskId },
    }).where(eq(heartbeatRuns.id, f.sourceRunId));
    const { app, wake } = appFor();
    const body = scenario === "wrong_decision_run" ? { ...f.body,
      executionReconciliation: { ...f.body.executionReconciliation, runId: other.sourceRunId } } : f.body;
    await request(app).post(`/api/issues/${f.issueId}/recovery-actions/resolve`).send(body).expect(409);
    await assertSourceUnchanged(f);
    expect(wake).not.toHaveBeenCalled();
  });

  it("does not authorize ordinary execution reconciliation through the repair-only request shape", async () => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ resultJson: { conversationContinuation: "continue_conversation_v1" } })
      .where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.update(issueRecoveryActions).set({ evidence: { runId: f.sourceRunId, automaticRecovery: { replay: "blocked" } } })
      .where(eq(issueRecoveryActions.id, f.actionId));
    const { app, wake } = appFor();
    await request(app).post(`/api/issues/${f.issueId}/recovery-actions/resolve`).send(f.body).expect(409);
    await assertSourceUnchanged(f);
    expect(wake).not.toHaveBeenCalled();
  });

  it("rejects a client-supplied repair-only authority flag", async () => {
    const f = await seed();
    const { app, wake } = appFor();
    await request(app).post(`/api/issues/${f.issueId}/recovery-actions/resolve`)
      .send({ ...f.body, workspaceRepairOnly: true }).expect(400);
    await assertSourceUnchanged(f);
    expect(wake).not.toHaveBeenCalled();
  });

  it.each(["missing_repair_evidence", "unconfirmed_stop", "missing_source_marker", "status_change"])("rejects %s without resolving the hold", async scenario => {
    const f = await seed();
    if (scenario === "unconfirmed_stop") await db.update(environmentLeases).set({ metadata: {} }).where(eq(environmentLeases.id, f.leaseId));
    if (scenario === "missing_source_marker") await db.update(heartbeatRuns).set({ resultJson: { workspaceRestoreFailure: "restore_failed" } })
      .where(eq(heartbeatRuns.id, f.sourceRunId));
    const { app, wake } = appFor();
    const body = scenario === "missing_repair_evidence" ? { ...f.body,
      executionReconciliation: { ...f.body.executionReconciliation, workspaceRepairEvidence: undefined } }
      : scenario === "status_change" ? { ...f.body, sourceIssueStatus: "todo" } : f.body;
    await request(app).post(`/api/issues/${f.issueId}/recovery-actions/resolve`).send(body)
      .expect(scenario === "missing_repair_evidence" ? 400 : 409);
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toEqual(f.issueBefore);
    expect((await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.id, f.actionId),
      eq(issueRecoveryActions.companyId, f.companyId))))[0].evidence).not.toHaveProperty("executionReconciliation");
    expect(wake).not.toHaveBeenCalled();
  });
});
