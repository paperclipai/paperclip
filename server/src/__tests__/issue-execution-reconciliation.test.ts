import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog, agents, agentRuntimeState, agentWakeupRequests, authUsers, companies, companySkills,
  createDb, documentRevisions, documents, executionWorkspaces, heartbeatRunEvents, heartbeatRuns, projects,
  issueComments, issueDocuments, issueRecoveryActions, issueRelations, issues, issueWorkProducts,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { agentRoutes } from "../routes/agents.js";
import { heartbeatService } from "../services/heartbeat.js";
import { deliverReconciledExecutions, settleUnrecoverableExecutions } from "../services/execution-recovery-resolution.js";
import { terminalizeLegacyExecution } from "../services/legacy-execution-recovery.js";

describe("issue execution reconciliation with real routes and Postgres", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const children: Array<{ child: ChildProcessWithoutNullStreams; closed: Promise<unknown> }> = [];

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-execution-reconciliation-");
    db = createDb(database.connectionString);
    heartbeat = heartbeatService(db);
  }, 90_000);

  afterEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    for (const { child, closed } of children.splice(0)) {
      child.stdin.end();
      await closed;
    }
    await db.delete(activityLog);
    await db.delete(issueWorkProducts);
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(heartbeatRunEvents);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await database?.cleanup();
  });

  async function startProvider() {
    const child = spawn("cat", [], { stdio: "pipe", detached: true });
    const closed = once(child, "close");
    children.push({ child, closed });
    await once(child, "spawn");
    return { child, closed, startedAt: new Date() };
  }

  async function fixture(asAgent = false) {
    const actorRunId = randomUUID();
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Test operator",
      email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    const [company] = await db.insert(companies).values({ name: "Reconciliation",
      issuePrefix: `R${randomUUID().slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: userId, requireBoardApprovalForNewAgents: false }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company!.id,
      name: "Executor", role: "engineer", status: "active", adapterType: "process",
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company!.id,
      title: "Recover continuation", status: "in_progress", assigneeAgentId: agent!.id,
      responsibleUserId: userId }).returning();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = asAgent
        ? { type: "agent", companyId: company!.id, agentId: agent!.id, runId: actorRunId, source: "agent_jwt" }
        : { type: "board", userId, source: "local_implicit", isInstanceAdmin: true };
      next();
    });
    app.use("/api", issueRoutes(db, {} as Parameters<typeof issueRoutes>[1]));
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return { company: company!, agent: agent!, issue: issue!, app, actorRunId };
  }

  async function occupyDispatchSlot(f: Awaited<ReturnType<typeof fixture>>) {
    const provider = await startProvider();
    await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
      invocationSource: "on_demand", status: "running", startedAt: provider.startedAt,
      processPid: provider.child.pid });
  }

  async function settledProcessHold(stopped = true, asAgent = false) {
    const f = await fixture(asAgent);
    const provider = await startProvider();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id,
      agentId: f.agent.id, invocationSource: "on_demand", status: "running",
      startedAt: provider.startedAt, processPid: provider.child.pid, processGroupId: provider.child.pid,
      contextSnapshot: { issueId: f.issue.id } }).returning();
    if (stopped) {
      provider.child.stdin.end();
      await provider.closed;
    }
    await terminalizeLegacyExecution({ db, run: run!, status: "cancelled",
      patch: { finishedAt: new Date(), errorCode: "process_lost" } });
    await settleUnrecoverableExecutions(db);
    return { ...f, run: run! };
  }

  function resolutionBody(runId: string) {
    return { outcome: "restored", sourceIssueStatus: "todo", resolutionNote: "The test provider exited without actions.",
      executionReconciliation: { runId, providerStopped: true, actionOutcome: "not_performed",
        outcomeEvidence: "The test-owned cat process exited after stdin closed and performed no external actions." } };
  }

  it.each(["legacy_execution_requires_reconciliation", "uncertain_external_action", "native_continuation_requires_reconciliation"])("continues an active %s guard with unknown outcomes", async cause => {
    const f = await settledProcessHold();
    await occupyDispatchSlot(f);
    await db.update(issueRecoveryActions).set({ status: "active", outcome: null, resolvedAt: null, cause })
      .where(eq(issueRecoveryActions.sourceIssueId, f.issue.id));
    const body = resolutionBody(f.run.id);
    body.executionReconciliation.actionOutcome = "unknown";
    await request(f.app).post(`/api/issues/${f.issue.id}/recovery-actions/resolve`).send(body).expect(200);
    await heartbeat.drainActiveRunExecutions();
    expect((await request(f.app).get(`/api/issues/${f.issue.id}`).expect(200)).body.executionBlocker).toBeNull();
  });

  it.each(["queued", "claimed", "running"])("rejects continuation of a %s source run without changing its guard", async status => {
    const f = await settledProcessHold();
    await db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, f.run.id));
    await request(f.app).post(`/api/issues/${f.issue.id}/recovery-actions/resolve`).send(resolutionBody(f.run.id)).expect(409);
    expect((await request(f.app).get(`/api/issues/${f.issue.id}`).expect(200)).body.executionBlocker).toMatchObject({ runId: f.run.id });
  });

  it("rejects an unconfirmed provider stop without changing its guard", async () => {
    const f = await settledProcessHold();
    const body = resolutionBody(f.run.id);
    await request(f.app).post(`/api/issues/${f.issue.id}/recovery-actions/resolve`).send({
      ...body, executionReconciliation: { ...body.executionReconciliation, providerStopped: false },
    }).expect(409);
    expect((await request(f.app).get(`/api/issues/${f.issue.id}`).expect(200)).body.executionBlocker).toMatchObject({ runId: f.run.id });
  });

  it("allows the authenticated task owner to reconcile unknown outcomes", async () => {
    const f = await settledProcessHold(true, true);
    await db.insert(heartbeatRuns).values({ id: f.actorRunId, companyId: f.company.id,
      agentId: f.agent.id, status: "running", invocationSource: "on_demand",
      startedAt: new Date(), contextSnapshot: { issueId: f.issue.id } });
    const body = resolutionBody(f.run.id);
    body.executionReconciliation.actionOutcome = "unknown";
    const response = await request(f.app).post(`/api/issues/${f.issue.id}/recovery-actions/resolve`).send(body).expect(200);
    expect(response.body.recoveryAction.evidence.executionReconciliation).toMatchObject({
      actorId: f.agent.id, recordedByUserId: null, actionOutcome: "unknown" });
    await heartbeat.drainActiveRunExecutions();
  });

  it("refuses reconciliation from an agent that neither owns the task nor the recovery action", async () => {
    const f = await settledProcessHold();
    const [other] = await db.insert(agents).values({ companyId: f.company.id, name: "Bystander",
      role: "engineer", status: "active", adapterType: "process" }).returning();
    const otherRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: otherRunId, companyId: f.company.id,
      agentId: other!.id, status: "running", invocationSource: "on_demand",
      startedAt: new Date(), contextSnapshot: { issueId: f.issue.id } });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent", companyId: f.company.id, agentId: other!.id, runId: otherRunId, source: "agent_jwt" };
      next();
    });
    app.use("/api", issueRoutes(db, {} as Parameters<typeof issueRoutes>[1]));
    app.use(errorHandler);
    const before = (await request(f.app).get(`/api/issues/${f.issue.id}`).expect(200)).body.executionBlocker;
    expect(before).toMatchObject({ runId: f.run.id });
    await request(app).post(`/api/issues/${f.issue.id}/recovery-actions/resolve`)
      .send(resolutionBody(f.run.id)).expect(403);
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, before.recoveryActionId));
    expect(hold!.evidence).not.toHaveProperty("executionReconciliation");
    expect((await request(f.app).get(`/api/issues/${f.issue.id}`).expect(200)).body.executionBlocker)
      .toMatchObject({ runId: f.run.id });
  });

  it("rejects a live process group even when the process PID is missing", async () => {
    const f = await settledProcessHold(false);
    await db.update(heartbeatRuns).set({ processPid: null }).where(eq(heartbeatRuns.id, f.run.id));
    await request(f.app).post(`/api/issues/${f.issue.id}/recovery-actions/resolve`).send(resolutionBody(f.run.id)).expect(409);
    expect((await request(f.app).get(`/api/issues/${f.issue.id}`).expect(200)).body.executionBlocker).toMatchObject({ runId: f.run.id });
  });

  it("accepts a retained stop receipt after the local process identity was cleared", async () => {
    const f = await settledProcessHold();
    await occupyDispatchSlot(f);
    await db.insert(heartbeatRunEvents).values({ companyId: f.company.id, runId: f.run.id,
      agentId: f.agent.id, seq: 100, eventType: "native.local_process_stopped", level: "info",
      stream: "system", message: "The test-owned provider exited." });
    await db.update(heartbeatRuns).set({ processPid: null, processGroupId: null }).where(eq(heartbeatRuns.id, f.run.id));
    await request(f.app).post(`/api/issues/${f.issue.id}/recovery-actions/resolve`).send(resolutionBody(f.run.id)).expect(200);
    await heartbeat.drainActiveRunExecutions();
  });

  it("a run cancelled after process start retains a settled hold accepted by the canonical resolve route", async () => {
    const f = await settledProcessHold();
    const issue = await request(f.app).get(`/api/issues/${f.issue.id}`).expect(200);
    expect(issue.body.executionBlocker).toMatchObject({ runId: f.run.id,
      cause: "legacy_execution_requires_reconciliation" });
    const actions = await request(f.app).get(`/api/issues/${f.issue.id}/recovery-actions`).expect(200);
    // The hold is settled, so no active action remains to name in the request.
    expect(actions.body.actions.filter((action: { status: string }) => action.status === "active")).toEqual([]);
    const [settled] = await db.select().from(issueRecoveryActions).where(eq(
      issueRecoveryActions.id, issue.body.executionBlocker.recoveryActionId,
    ));
    expect(settled).toMatchObject({ status: "resolved", outcome: "blocked",
      evidence: { automaticRecovery: { replay: "blocked" } } });
    await occupyDispatchSlot(f);
    const resolution = await request(f.app).post(`/api/issues/${f.issue.id}/recovery-actions/resolve`)
      .send(resolutionBody(f.run.id));
    expect(resolution.status).toBe(200);
    expect(resolution.body.issue).toMatchObject({ status: "todo" });
    expect(resolution.body.recoveryAction).toMatchObject({ id: settled.id, status: "resolved", outcome: "handed_back" });
    expect((await request(f.app).get(`/api/issues/${f.issue.id}`).expect(200)).body.executionBlocker).toBeNull();
  });

  it.each(["completed", "not_performed", "mixed", "unknown"])("keeps task state and records the reconciliation while continuing a settled %s outcome", async actionOutcome => {
    const f = await settledProcessHold();
    await occupyDispatchSlot(f);
    const [project] = await db.insert(projects).values({ companyId: f.company.id, name: "Task project" }).returning();
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId: f.company.id,
      projectId: project!.id, mode: "isolated_workspace", strategyType: "git_worktree",
      name: "Task workspace", branchName: "tasks/fixture", cwd: process.cwd() }).returning();
    const state = { status: "changes_requested", currentStageId: randomUUID(),
      returnAssignee: { type: "agent", agentId: f.agent.id }, changesRequestedCount: 2 };
    await db.update(issues).set({ status: "blocked", executionState: state, projectId: project!.id,
      executionWorkspaceId: workspace!.id }).where(eq(issues.id, f.issue.id));
    const [product] = await db.insert(issueWorkProducts).values({ companyId: f.company.id,
      issueId: f.issue.id, type: "branch", provider: "github", title: "Task branch", status: "active",
      externalId: "tasks/fixture", metadata: { workspace: "/test-owned/workspace" } }).returning();
    const [before] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issue.id));
    const body = resolutionBody(f.run.id);
    body.executionReconciliation.actionOutcome = actionOutcome;
    const response = await request(f.app).post(`/api/issues/${f.issue.id}/recovery-actions/resolve`).send(body).expect(200);
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    await heartbeat.drainActiveRunExecutions();
    expect(response.body.issue).toMatchObject({ status: "todo", assigneeAgentId: f.agent.id,
      executionState: state, executionWorkspaceId: workspace!.id });
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, before!.id));
    expect(before!.evidence.automaticRecovery).toMatchObject({ replay: "blocked" });
    expect(action!.evidence).not.toHaveProperty("automaticRecovery");
    expect(action!.evidence.executionReconciliation).toMatchObject({ ...body.executionReconciliation,
      recordedByUserId: f.company.defaultResponsibleUserId, recordedAt: expect.any(String) });
    expect(action!.evidence).toMatchObject({ continuationDelivery: "delivered", continuationRunId: expect.any(String) });
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, String(action!.evidence.continuationRunId)));
    expect(successor).toMatchObject({ retryOfRunId: f.run.id,
      contextSnapshot: { forceFreshSession: true, previousRunId: f.run.id } });
    expect((await request(f.app).get(`/api/issues/${f.issue.id}`).expect(200)).body.executionBlocker).toBeNull();
    expect(await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, product!.id))).toEqual([product]);
    // The issue read above records privacy sources in the workspace metadata.
    // The binding itself must not change.
    const [after] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspace!.id));
    expect({ ...after, metadata: null }).toEqual({ ...workspace, metadata: null });
  });

  it.each([true, false])("replays a reconciled receipt with actionId=%s and keeps one continuation", async withActionId => {
    const f = await settledProcessHold();
    await occupyDispatchSlot(f);
    const body = resolutionBody(f.run.id);
    const first = await request(f.app).post(`/api/issues/${f.issue.id}/recovery-actions/resolve`).send(body).expect(200);
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    await heartbeat.drainActiveRunExecutions();
    const actionId = first.body.recoveryAction.id;
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, actionId));
    const successorId = action!.evidence.continuationRunId;
    expect(successorId).toEqual(expect.any(String));
    await db.update(issueRecoveryActions).set({ evidence: { ...action!.evidence,
      continuationDelivery: "pending", continuationRunId: undefined } }).where(eq(issueRecoveryActions.id, actionId));
    for (let attempt = 0; attempt < 2; attempt++) {
      const replay = await request(f.app).post(`/api/issues/${f.issue.id}/recovery-actions/resolve`)
        .send({ ...body, ...(withActionId ? { actionId } : {}) }).expect(200);
      expect(replay.body).toMatchObject({ replayed: true,
        recoveryAction: { id: actionId, cause: "legacy_execution_requires_reconciliation" } });
      expect(replay.body.recoveryAction.companyId).toBe(f.company.id);
    }
    // The delivery queue finishes the pending delivery with the same wake key.
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    await heartbeat.drainActiveRunExecutions();
    const [delivered] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, actionId));
    expect(delivered!.evidence).toMatchObject({ continuationDelivery: "delivered", continuationRunId: successorId });
    const successors = await db.select().from(heartbeatRuns).where(sql`${heartbeatRuns.contextSnapshot}->>'recoveryActionId' = ${actionId}`);
    expect(successors).toHaveLength(1);
  });

  it.each([true, false])("rejects conflicting run or outcome on a settled receipt with actionId=%s", async withActionId => {
    const f = await settledProcessHold();
    await occupyDispatchSlot(f);
    const body = resolutionBody(f.run.id);
    const first = await request(f.app).post(`/api/issues/${f.issue.id}/recovery-actions/resolve`).send(body).expect(200);
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    await heartbeat.drainActiveRunExecutions();
    for (const delta of [{ runId: randomUUID() }, { actionOutcome: "completed" }]) {
      await request(f.app).post(`/api/issues/${f.issue.id}/recovery-actions/resolve`).send({
        ...body, ...(withActionId ? { actionId: first.body.recoveryAction.id } : {}),
        executionReconciliation: { ...body.executionReconciliation, ...delta },
      }).expect(409);
    }
  });

  it("rejects a local run whose process identity and stop evidence are missing", async () => {
    const f = await settledProcessHold();
    await db.update(heartbeatRuns).set({ processPid: null, processGroupId: null }).where(eq(heartbeatRuns.id, f.run.id));
    await request(f.app).post(`/api/issues/${f.issue.id}/recovery-actions/resolve`).send(resolutionBody(f.run.id)).expect(409);
    expect((await request(f.app).get(`/api/issues/${f.issue.id}`).expect(200)).body.executionBlocker).toMatchObject({ runId: f.run.id });
  });

  it("accepts a local preparation failure that proves no provider started", async () => {
    const f = await settledProcessHold();
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
    await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.run.id));
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "setup_failed", executionStage: "preparing",
      runtimeMode: "legacy", runtimeModeResolvedAt: null, processPid: null, processGroupId: null, processStartedAt: null,
      sessionIdAfter: null, nativeIssueId: null, nativeSessionId: null, controllerLeaseExpiresAt: null,
      runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
      resultJson: { ...source!.resultJson, executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    }).where(eq(heartbeatRuns.id, f.run.id));
    await request(f.app).post(`/api/issues/${f.issue.id}/recovery-actions/resolve`).send(resolutionBody(f.run.id)).expect(200);
  });

  it.each(["live_provider", "wrong_source", "missing_evidence"])("preserves a settled hold on %s", async kind => {
    const f = await settledProcessHold(kind !== "live_provider");
    const body = resolutionBody(kind === "wrong_source" ? randomUUID() : f.run.id);
    const { executionReconciliation, ...withoutEvidence } = body;
    await request(f.app).post(`/api/issues/${f.issue.id}/recovery-actions/resolve`)
      .send(kind === "missing_evidence" ? withoutEvidence : body)
      .expect(kind === "missing_evidence" ? 404 : 409);
    const issue = await request(f.app).get(`/api/issues/${f.issue.id}`).expect(200);
    expect(issue.body.executionBlocker).toMatchObject({ runId: f.run.id });
    expect((await db.select().from(issueRecoveryActions).where(eq(
      issueRecoveryActions.id, issue.body.executionBlocker.recoveryActionId,
    )))[0]).toMatchObject({ status: "resolved", outcome: "blocked" });
  });
});
