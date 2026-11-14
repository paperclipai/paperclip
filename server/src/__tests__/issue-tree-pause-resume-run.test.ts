import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  authUsers,
  closeRegisteredClients,
  companies,
  companyMemberships,
  companySkills,
  costEvents,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRecoveryActions,
  issueTreeHoldMembers,
  issueTreeHolds,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";

// Hold one run in host preparation, before the legacy adapter is entered, so a
// subtree pause can interrupt it exactly where the staging retry was stopped.
const preparationGate = vi.hoisted(() => ({
  blockNext: false,
  blockedRunId: null as string | null,
  reached: null as null | (() => void),
  release: null as null | (() => void),
}));
vi.mock("../services/heartbeat/run-preparation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat/run-preparation.js")>();
  return {
    ...actual,
    buildPaperclipRuntimeMcpServers: async (input: Parameters<typeof actual.buildPaperclipRuntimeMcpServers>[0]) => {
      if (preparationGate.blockNext) {
        preparationGate.blockNext = false;
        preparationGate.blockedRunId = input.runId;
        await new Promise<void>((resolve) => {
          preparationGate.release = resolve;
          preparationGate.reached?.();
        });
      }
      return actual.buildPaperclipRuntimeMcpServers(input);
    },
  };
});

const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL?.trim();
const embeddedPostgresSupport = externalTestDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const ADAPTER = "tree_pause_resume_test";

describeEmbeddedPostgres("subtree pause and release of an in-flight child run", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let heartbeat!: ReturnType<typeof import("../services/heartbeat.ts").heartbeatService>;
  let getExecutionBlocker!: typeof import("../services/execution-blocker.js").getExecutionBlocker;
  let app!: express.Express;
  const executedRunIds: string[] = [];
  const adapterGate = { block: false, entered: null as null | (() => void) };

  beforeAll(async () => {
    if (externalTestDatabaseUrl) db = createDb(externalTestDatabaseUrl);
    else {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tree-pause-resume-");
      db = createDb(tempDb.connectionString);
    }
    const [{ heartbeatService }, blocker, { issueTreeControlRoutes }, { errorHandler }] = await Promise.all([
      import("../services/heartbeat.ts"),
      import("../services/execution-blocker.js"),
      import("../routes/issue-tree-control.js"),
      import("../middleware/index.js"),
    ]);
    heartbeat = heartbeatService(db);
    getExecutionBlocker = blocker.getExecutionBlocker;
    registerServerAdapter({
      type: ADAPTER,
      execute: async (input) => {
        executedRunIds.push(input.runId);
        if (adapterGate.block) {
          adapterGate.entered?.();
          await new Promise<void>((resolve) => {
            if (input.signal?.aborted) return resolve();
            input.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        // Finish the task so liveness follow-ups do not add unrelated runs.
        const issueId = (input.context as { issueId?: unknown }).issueId;
        if (typeof issueId === "string" && !input.signal?.aborted) {
          await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, issueId));
        }
        return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
      },
      testEnvironment: async () => ({ adapterType: ADAPTER, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", userId: "board-user", source: "local_implicit", isInstanceAdmin: false };
      next();
    });
    app.use("/api", issueTreeControlRoutes(db));
    app.use(errorHandler);
  }, 30_000);

  afterEach(async () => {
    preparationGate.release?.();
    Object.assign(preparationGate, { blockNext: false, blockedRunId: null, reached: null, release: null });
    adapterGate.block = false;
    adapterGate.entered = null;
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    executedRunIds.length = 0;
    for (const table of [costEvents, activityLog, issueRecoveryActions, issueTreeHoldMembers, issueTreeHolds,
      environmentLeases, heartbeatRunEvents]) await db.delete(table);
    await db.update(issues).set({ executionRunId: null, checkoutRunId: null });
    for (const table of [issues, heartbeatRuns, agentWakeupRequests, agentRuntimeState, agents, companySkills,
      companyMemberships, companies]) await db.delete(table);
  });

  afterAll(async () => {
    unregisterServerAdapter(ADAPTER);
    if (externalTestDatabaseUrl) await closeRegisteredClients(externalTestDatabaseUrl);
    await db?.$client.end();
    await tempDb?.cleanup();
  });

  async function seedTree() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const parentId = randomUUID();
    const childId = randomUUID();
    const prefix = `P${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`;
    const now = new Date();
    await db.insert(companies).values({ id: companyId, name: "Pause co", issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user" });
    await db.insert(authUsers).values({ id: "responsible-user", name: "Responsible", email: "tree-pause@example.test",
      createdAt: now, updatedAt: now }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user",
      status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Nibbler", role: "engineer", status: "idle",
      adapterType: ADAPTER, adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: parentId, companyId, title: "Parent", status: "in_progress", priority: "medium",
      responsibleUserId: "responsible-user", assigneeUserId: "responsible-user", issueNumber: 1, identifier: `${prefix}-1` });
    await db.insert(issues).values({ id: childId, companyId, parentId, title: "Child", status: "todo", priority: "medium",
      responsibleUserId: "responsible-user", assigneeAgentId: agentId, issueNumber: 2, identifier: `${prefix}-2` });
    return { companyId, agentId, parentId, childId, prefix };
  }

  function wakeChild(fixture: Awaited<ReturnType<typeof seedTree>>) {
    return heartbeat.wakeup(fixture.agentId, {
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: fixture.childId }, requestedByActorType: "system", requestedByActorId: "system",
      contextSnapshot: { issueId: fixture.childId, taskId: fixture.childId, wakeReason: "issue_assigned" },
    });
  }

  async function childRuns(childId: string) {
    const rows = await db.select().from(heartbeatRuns);
    return rows.filter((run) => run.contextSnapshot?.issueId === childId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async function pauseAndRelease(
    fixture: Awaited<ReturnType<typeof seedTree>>,
    hooks: { afterPause?: () => Promise<void>; whilePaused?: () => Promise<void> } = {},
  ) {
    const pause = await request(app).post(`/api/issues/${fixture.parentId}/tree-holds`)
      .send({ mode: "pause", reason: "soak pause" });
    expect(pause.status).toBe(201);
    await hooks.afterPause?.();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await hooks.whilePaused?.();
    const release = await request(app)
      .post(`/api/issues/${fixture.parentId}/tree-holds/${pause.body.hold.id}/release`)
      .send({ reason: "soak resume" });
    expect(release.status).toBe(200);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    return pause.body.hold.id as string;
  }

  it("re-dispatches a child whose run was paused during preparation exactly once, without reconciliation", async () => {
    const fixture = await seedTree();
    const prepared = new Promise<void>((resolve) => { preparationGate.reached = resolve; });
    preparationGate.blockNext = true;
    await wakeChild(fixture);
    await prepared;
    const interruptedRunId = preparationGate.blockedRunId!;

    const holdId = await pauseAndRelease(fixture, {
      // The executor observes the operator Stop at its dispatch gate.
      afterPause: async () => { preparationGate.release?.(); },
      whilePaused: async () => {
        // Nothing runs during the hold, and the Stop needs no reconciliation.
        expect((await childRuns(fixture.childId)).map((run) => run.status)).toEqual(["cancelled"]);
        expect(await getExecutionBlocker(db, fixture.companyId, fixture.childId)).toBeNull();
      },
    });

    const runs = await childRuns(fixture.childId);
    expect(runs[0]).toMatchObject({ id: interruptedRunId, status: "cancelled" });
    expect(executedRunIds).not.toContain(interruptedRunId);
    const resumed = runs.slice(1);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({ status: "succeeded" });
    expect(resumed[0]!.contextSnapshot).toMatchObject({ wakeReason: "issue_tree_resumed", holdId });
    expect(executedRunIds).toEqual([resumed[0]!.id]);
    const holds = await db.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.sourceIssueId, fixture.childId), eq(issueRecoveryActions.status, "active")));
    expect(holds).toEqual([]);
    expect(await getExecutionBlocker(db, fixture.companyId, fixture.childId)).toBeNull();
    const [child] = await db.select().from(issues).where(eq(issues.id, fixture.childId));
    expect(child!.status).toBe("done");

    // The released hold owes its work once; a repeated release cannot replay it.
    const again = await request(app).post(`/api/issues/${fixture.parentId}/tree-holds/${holdId}/release`)
      .send({ reason: "duplicate resume" });
    expect(again.status).toBe(409);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(await childRuns(fixture.childId)).toHaveLength(2);
  });

  async function pauseWhilePreparing(fixture: Awaited<ReturnType<typeof seedTree>>, rootId = fixture.parentId) {
    const prepared = new Promise<void>((resolve) => { preparationGate.reached = resolve; });
    preparationGate.blockNext = true;
    await wakeChild(fixture);
    await prepared;
    const pause = await request(app).post(`/api/issues/${rootId}/tree-holds`).send({ mode: "pause" });
    expect(pause.status).toBe(201);
    return { interruptedRunId: preparationGate.blockedRunId!, holdId: pause.body.hold.id as string };
  }

  it("resumes once when the pause is released before the stopped preparation finishes unwinding", async () => {
    const fixture = await seedTree();
    const { interruptedRunId, holdId } = await pauseWhilePreparing(fixture);
    // The periodic disposition must not block a Stop its executor still owns.
    const { settleUnrecoverableExecutions } = await import("../services/execution-recovery-resolution.js");
    await settleUnrecoverableExecutions(db);
    const release = await request(app).post(`/api/issues/${fixture.parentId}/tree-holds/${holdId}/release`).send({});
    expect(release.status).toBe(200);
    expect((await childRuns(fixture.childId)).map((run) => run.status)).toEqual(["cancelled"]);
    const [held] = await db.select().from(issues).where(eq(issues.id, fixture.childId));
    expect(held!.status).not.toBe("blocked");

    preparationGate.release?.();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const runs = await childRuns(fixture.childId);
    expect(runs.map((run) => run.contextSnapshot?.wakeReason)).toEqual(["issue_assigned", "issue_tree_resumed"]);
    expect(runs[1]).toMatchObject({ status: "succeeded" });
    expect(runs[1]!.contextSnapshot).toMatchObject({ holdId, interruptedRunId });
    expect(await getExecutionBlocker(db, fixture.companyId, fixture.childId)).toBeNull();
  });

  it("clears an automatic no-replay block recorded before the executor proved no adapter started", async () => {
    const fixture = await seedTree();
    const { interruptedRunId, holdId } = await pauseWhilePreparing(fixture);
    // Model a disposition that ran after the controller lease lapsed.
    await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(0) }).where(eq(heartbeatRuns.id, interruptedRunId));
    const { settleUnrecoverableExecutions } = await import("../services/execution-recovery-resolution.js");
    await settleUnrecoverableExecutions(db);
    const [blocked] = await db.select().from(issues).where(eq(issues.id, fixture.childId));
    expect(blocked!.status).toBe("blocked");

    preparationGate.release?.();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(await getExecutionBlocker(db, fixture.companyId, fixture.childId)).toBeNull();
    const [restored] = await db.select().from(issues).where(eq(issues.id, fixture.childId));
    expect(restored!.status).toBe("in_progress");

    const release = await request(app).post(`/api/issues/${fixture.parentId}/tree-holds/${holdId}/release`).send({});
    expect(release.status).toBe(200);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const runs = await childRuns(fixture.childId);
    expect(runs.map((run) => run.contextSnapshot?.wakeReason)).toEqual(["issue_assigned", "issue_tree_resumed"]);
  });

  it("keeps the interrupted work owed across overlapping pauses until the last one is released", async () => {
    const fixture = await seedTree();
    const { interruptedRunId, holdId: childHoldId } = await pauseWhilePreparing(fixture, fixture.childId);
    preparationGate.release?.();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const parentPause = await request(app).post(`/api/issues/${fixture.parentId}/tree-holds`).send({ mode: "pause" });
    expect(parentPause.status).toBe(201);

    const childRelease = await request(app)
      .post(`/api/issues/${fixture.childId}/tree-holds/${childHoldId}/release`).send({});
    expect(childRelease.status).toBe(200);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(await childRuns(fixture.childId)).toHaveLength(1);

    const parentRelease = await request(app)
      .post(`/api/issues/${fixture.parentId}/tree-holds/${parentPause.body.hold.id}/release`).send({});
    expect(parentRelease.status).toBe(200);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const runs = await childRuns(fixture.childId);
    expect(runs.map((run) => run.contextSnapshot?.wakeReason)).toEqual(["issue_assigned", "issue_tree_resumed"]);
    expect(runs[1]!.contextSnapshot).toMatchObject({ holdId: childHoldId, interruptedRunId });
  });

  it("lets only one of two concurrent releases resume the interrupted work", async () => {
    const fixture = await seedTree();
    const { holdId } = await pauseWhilePreparing(fixture);
    preparationGate.release?.();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const url = `/api/issues/${fixture.parentId}/tree-holds/${holdId}/release`;
    const responses = await Promise.all([request(app).post(url).send({}), request(app).post(url).send({})]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const runs = await childRuns(fixture.childId);
    expect(runs.map((run) => run.contextSnapshot?.wakeReason)).toEqual(["issue_assigned", "issue_tree_resumed"]);
  });

  it("finishes a resume whose wake was not saved before a restart, exactly once", async () => {
    const fixture = await seedTree();
    const { interruptedRunId, holdId } = await pauseWhilePreparing(fixture);
    preparationGate.release?.();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    // The release claimed the work, then the process stopped before the wake was saved.
    const claimedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    await db.update(issueTreeHolds).set({ status: "released", releasedAt: new Date() }).where(eq(issueTreeHolds.id, holdId));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, interruptedRunId));
    await db.update(heartbeatRuns).set({ resultJson: { ...run!.resultJson, treeHoldResume: { holdId, state: "pending", claimedAt } } })
      .where(eq(heartbeatRuns.id, interruptedRunId));

    const { deliverPendingPauseResumes, hasPendingPauseResume } = await import("../services/issue-tree-resume.js");
    expect(await hasPendingPauseResume(db)).toBe(true);
    await deliverPendingPauseResumes(db, (agentId, opts) => heartbeat.wakeup(agentId, opts));
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await deliverPendingPauseResumes(db, (agentId, opts) => heartbeat.wakeup(agentId, opts), new Date(Date.now() + 5 * 60_000));
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const runs = await childRuns(fixture.childId);
    expect(runs.map((row) => row.contextSnapshot?.wakeReason)).toEqual(["issue_assigned", "issue_tree_resumed"]);
    expect(runs[1]).toMatchObject({ status: "succeeded" });
    expect(await hasPendingPauseResume(db)).toBe(false);
  });

  it("does not let a stalled dispatcher repeat a resume the sweep already took over", async () => {
    const fixture = await seedTree();
    const { holdId } = await pauseWhilePreparing(fixture);
    preparationGate.release?.();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db.update(issueTreeHolds).set({ status: "released", releasedAt: new Date() }).where(eq(issueTreeHolds.id, holdId));

    // The first dispatcher claims the work, then stalls before its wake is saved.
    const { resumePauseInterruptedWork, deliverPendingPauseResumes } = await import("../services/issue-tree-resume.js");
    let resumeStalled!: () => void;
    const stalled = new Promise<void>((resolve) => { resumeStalled = resolve; });
    let continueStalled!: () => void;
    const gate = new Promise<void>((resolve) => { continueStalled = resolve; });
    const slow = resumePauseInterruptedWork(db, {
      companyId: fixture.companyId, issueIds: [fixture.childId], actor: { actorType: "system", actorId: "system" },
      wakeup: async (agentId, opts) => { resumeStalled(); await gate; return heartbeat.wakeup(agentId, opts); },
    });
    await stalled;

    // The sweep takes over the stale claim and the replacement run finishes
    // while the task stays open.
    await deliverPendingPauseResumes(db, (agentId, opts) => heartbeat.wakeup(agentId, opts), new Date(Date.now() + 5 * 60_000));
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db.update(issues).set({ status: "in_progress", completedAt: null }).where(eq(issues.id, fixture.childId));

    continueStalled();
    expect(await slow).toEqual([]);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const runs = await childRuns(fixture.childId);
    expect(runs.map((run) => run.contextSnapshot?.wakeReason)).toEqual(["issue_assigned", "issue_tree_resumed"]);
    const wakes = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, `tree-hold-resume:${runs[0]!.id}`));
    expect(wakes).toHaveLength(1);
  });

  it("keeps a resume owed when a new pause lands before its wake is admitted", async () => {
    const fixture = await seedTree();
    const { holdId } = await pauseWhilePreparing(fixture);
    preparationGate.release?.();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db.update(issueTreeHolds).set({ status: "released", releasedAt: new Date() }).where(eq(issueTreeHolds.id, holdId));

    // A second pause lands between the eligibility check and queue admission.
    const { resumePauseInterruptedWork, deliverPendingPauseResumes } = await import("../services/issue-tree-resume.js");
    let secondHoldId = "";
    expect(await resumePauseInterruptedWork(db, {
      companyId: fixture.companyId, issueIds: [fixture.childId], actor: { actorType: "system", actorId: "system" },
      wakeup: async (agentId, opts) => {
        const pause = await request(app).post(`/api/issues/${fixture.parentId}/tree-holds`).send({ mode: "pause" });
        expect(pause.status).toBe(201);
        secondHoldId = pause.body.hold.id;
        return heartbeat.wakeup(agentId, opts);
      },
    })).toEqual([]);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(await childRuns(fixture.childId)).toHaveLength(1);

    const release = await request(app).post(`/api/issues/${fixture.parentId}/tree-holds/${secondHoldId}/release`).send({});
    expect(release.status).toBe(200);
    await deliverPendingPauseResumes(db, (agentId, opts) => heartbeat.wakeup(agentId, opts), new Date(Date.now() + 5 * 60_000));
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const runs = await childRuns(fixture.childId);
    expect(runs.map((run) => run.contextSnapshot?.wakeReason)).toEqual(["issue_assigned", "issue_tree_resumed"]);
    expect(runs[1]).toMatchObject({ status: "succeeded" });
  });

  it("visits every stale resume claim even when the first page is still paused", async () => {
    const fixture = await seedTree();
    const { interruptedRunId, holdId } = await pauseWhilePreparing(fixture);
    preparationGate.release?.();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db.update(issueTreeHolds).set({ status: "released", releasedAt: new Date() }).where(eq(issueTreeHolds.id, holdId));

    // A full page of claims on tasks under another active pause sorts first.
    const pausedRootId = randomUUID();
    await db.insert(issues).values({ id: pausedRootId, companyId: fixture.companyId, title: "Paused root", status: "in_progress",
      priority: "medium", responsibleUserId: "responsible-user", assigneeUserId: "responsible-user", issueNumber: 10,
      identifier: `${fixture.prefix}-10` });
    const pausedChildIds = Array.from({ length: 25 }, () => randomUUID());
    for (const [index, id] of pausedChildIds.entries()) {
      await db.insert(issues).values({ id, companyId: fixture.companyId, parentId: pausedRootId, title: `Paused ${index}`,
        status: "in_progress", priority: "medium", responsibleUserId: "responsible-user", assigneeAgentId: fixture.agentId,
        issueNumber: 11 + index, identifier: `${fixture.prefix}-${11 + index}` });
    }
    const otherPause = await request(app).post(`/api/issues/${pausedRootId}/tree-holds`).send({ mode: "pause" });
    expect(otherPause.status).toBe(201);
    const claimedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const pendingClaim = { treeHoldResume: { holdId: otherPause.body.hold.id, state: "pending", claimedAt } };
    await db.insert(heartbeatRuns).values(pausedChildIds.map((issueId, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, companyId: fixture.companyId, agentId: fixture.agentId,
      status: "cancelled", finishedAt: new Date(Date.now() - 10 * 60_000), createdAt: new Date(Date.now() - 10 * 60_000),
      contextSnapshot: { issueId }, resultJson: pendingClaim,
    })));
    // The runnable claim sorts after that page.
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, interruptedRunId));
    await db.update(heartbeatRuns).set({ resultJson: { ...run!.resultJson, treeHoldResume: { holdId, state: "pending", claimedAt } } })
      .where(eq(heartbeatRuns.id, interruptedRunId));
    expect(interruptedRunId > `00000000-0000-4000-8000-${String(24).padStart(12, "0")}`).toBe(true);

    const { deliverPendingPauseResumes } = await import("../services/issue-tree-resume.js");
    await deliverPendingPauseResumes(db, (agentId, opts) => heartbeat.wakeup(agentId, opts));
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const runs = await childRuns(fixture.childId);
    expect(runs.map((row) => row.contextSnapshot?.wakeReason)).toEqual(["issue_assigned", "issue_tree_resumed"]);
  });

  it("re-dispatches a queued child run that the pause cancelled before it started", async () => {
    const fixture = await seedTree();
    // Occupy the agent's only slot so the child's run stays queued.
    const otherIssueId = randomUUID();
    await db.insert(issues).values({ id: otherIssueId, companyId: fixture.companyId, title: "Other", status: "todo",
      priority: "medium", responsibleUserId: "responsible-user", assigneeAgentId: fixture.agentId, issueNumber: 3,
      identifier: `${fixture.prefix}-3` });
    const prepared = new Promise<void>((resolve) => { preparationGate.reached = resolve; });
    preparationGate.blockNext = true;
    await heartbeat.wakeup(fixture.agentId, {
      source: "assignment", triggerDetail: "system", reason: "issue_assigned", payload: { issueId: otherIssueId },
      requestedByActorType: "system", requestedByActorId: "system",
      contextSnapshot: { issueId: otherIssueId, taskId: otherIssueId, wakeReason: "issue_assigned" },
    });
    await prepared;
    const queued = await wakeChild(fixture);
    expect(queued).toMatchObject({ status: "queued" });

    const holdId = await pauseAndRelease(fixture, {
      afterPause: async () => {
        expect((await childRuns(fixture.childId)).map((run) => run.status)).toEqual(["cancelled"]);
        preparationGate.release?.();
      },
      whilePaused: async () => {
        expect((await childRuns(fixture.childId)).map((run) => run.status)).toEqual(["cancelled"]);
      },
    });

    const runs = await childRuns(fixture.childId);
    expect(runs.map((run) => run.contextSnapshot?.wakeReason)).toEqual(["issue_assigned", "issue_tree_resumed"]);
    expect(runs[1]).toMatchObject({ status: "succeeded" });
    expect(runs[1]!.contextSnapshot).toMatchObject({ holdId, interruptedRunId: queued!.id });
    expect(await getExecutionBlocker(db, fixture.companyId, fixture.childId)).toBeNull();
  });

  // The staging S50b shape: a workspace_busy retry is parked when the board
  // pauses the tree, comes due during the pause, and the dispatch gate cancels
  // it with issue_paused. No operator Stop names that run in the hold snapshot.
  async function seedParkedWorkspaceBusyRetry(fixture: Awaited<ReturnType<typeof seedTree>>) {
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, fixture.childId));
    const context = { issueId: fixture.childId, taskId: fixture.childId, wakeReason: "issue_assigned" };
    const busyRunId = randomUUID();
    const retryRunId = randomUUID();
    const createdAt = new Date(Date.now() - 60_000);
    await db.insert(heartbeatRuns).values({ id: busyRunId, companyId: fixture.companyId, agentId: fixture.agentId,
      invocationSource: "assignment", triggerDetail: "system", status: "cancelled", errorCode: "workspace_busy",
      error: "Waiting for the shared execution workspace", contextSnapshot: context, createdAt,
      startedAt: createdAt, finishedAt: new Date(createdAt.getTime() + 1_000),
      resultJson: { executionRecovery: { kind: "workspace_wait", providerWorkStarted: false } } });
    await db.insert(heartbeatRuns).values({ id: retryRunId, companyId: fixture.companyId, agentId: fixture.agentId,
      invocationSource: "assignment", triggerDetail: "system", status: "scheduled_retry", retryOfRunId: busyRunId,
      scheduledRetryAttempt: 1, scheduledRetryReason: "workspace_busy",
      scheduledRetryAt: new Date(Date.now() + 1_000), contextSnapshot: { ...context, wakeReason: "workspace_busy_retry" },
      createdAt: new Date(createdAt.getTime() + 1_000) });
    return { busyRunId, retryRunId };
  }

  // "legacy" models a retry refused before gates recorded the hold (the staging run).
  for (const releaseVia of ["release", "resume", "legacy"] as const) {
    it(`resumes a parked retry the pause suppressed exactly once after ${releaseVia}`, async () => {
      const fixture = await seedTree();
      const { busyRunId, retryRunId } = await seedParkedWorkspaceBusyRetry(fixture);
      const pause = await request(app).post(`/api/issues/${fixture.parentId}/tree-holds`).send({ mode: "pause" });
      expect(pause.status).toBe(201);
      const holdId = pause.body.hold.id as string;

      // The retry comes due during the hold and the dispatch gate suppresses it.
      await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(Date.now() - 1_000) })
        .where(eq(heartbeatRuns.id, retryRunId));
      await heartbeat.promoteDueScheduledRetries(new Date());
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      const [suppressed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retryRunId));
      expect(suppressed).toMatchObject({ status: "cancelled", errorCode: "issue_paused" });
      expect(suppressed!.resultJson).toMatchObject({ treeHoldSuppression: { holdId } });
      if (releaseVia === "legacy") {
        await db.update(heartbeatRuns).set({ resultJson: null }).where(eq(heartbeatRuns.id, retryRunId));
      }
      expect(executedRunIds).toEqual([]);
      // The periodic stranded-issue sweep must not block or re-dispatch held work.
      await heartbeat.reconcileStrandedAssignedIssues();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      expect(await childRuns(fixture.childId)).toHaveLength(2);
      expect(await getExecutionBlocker(db, fixture.companyId, fixture.childId)).toBeNull();

      const released = releaseVia !== "resume"
        ? await request(app).post(`/api/issues/${fixture.parentId}/tree-holds/${holdId}/release`).send({})
        : await request(app).post(`/api/issues/${fixture.parentId}/tree-holds`).send({ mode: "resume" });
      expect(released.status).toBe(200);
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      // Stranded-issue recovery must not add a second executor for the same work.
      await heartbeat.reconcileStrandedAssignedIssues();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);

      const runs = await childRuns(fixture.childId);
      expect(runs.map((run) => run.id).slice(0, 2)).toEqual([busyRunId, retryRunId]);
      const resumed = runs.slice(2);
      expect(resumed).toHaveLength(1);
      expect(resumed[0]).toMatchObject({ status: "succeeded" });
      expect(resumed[0]!.contextSnapshot).toMatchObject({
        wakeReason: "issue_tree_resumed", holdId, interruptedRunId: retryRunId,
      });
      expect(executedRunIds).toEqual([resumed[0]!.id]);
      expect(await getExecutionBlocker(db, fixture.companyId, fixture.childId)).toBeNull();
      const [child] = await db.select().from(issues).where(eq(issues.id, fixture.childId));
      expect(child!.status).toBe("done");
    });
  }

  it("resumes a queued run the claim gate refused during the hold exactly once", async () => {
    const fixture = await seedTree();
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, fixture.childId));
    const pause = await request(app).post(`/api/issues/${fixture.parentId}/tree-holds`).send({ mode: "pause" });
    expect(pause.status).toBe(201);
    const holdId = pause.body.hold.id as string;

    // A run queued just before the hold, missed by its snapshot, reaches the claim gate.
    const queuedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: queuedRunId, companyId: fixture.companyId, agentId: fixture.agentId,
      invocationSource: "assignment", triggerDetail: "system", status: "queued",
      contextSnapshot: { issueId: fixture.childId, taskId: fixture.childId, wakeReason: "issue_assigned" } });
    // The claim gate holds the agent start lock; refusing the run must not wait on it.
    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const [refused] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queuedRunId));
    expect(refused).toMatchObject({ status: "cancelled", errorCode: "issue_paused" });
    expect(refused!.resultJson).toMatchObject({ treeHoldSuppression: { holdId } });
    expect(executedRunIds).toEqual([]);

    const release = await request(app).post(`/api/issues/${fixture.parentId}/tree-holds/${holdId}/release`).send({});
    expect(release.status).toBe(200);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await heartbeat.reconcileStrandedAssignedIssues();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const runs = await childRuns(fixture.childId);
    expect(runs.map((run) => run.contextSnapshot?.wakeReason)).toEqual(["issue_assigned", "issue_tree_resumed"]);
    expect(runs[1]).toMatchObject({ status: "succeeded" });
    expect(runs[1]!.contextSnapshot).toMatchObject({ holdId, interruptedRunId: queuedRunId });
    expect(executedRunIds).toEqual([runs[1]!.id]);
    expect(await getExecutionBlocker(db, fixture.companyId, fixture.childId)).toBeNull();
  });

  async function pauseAndSuppressRetry(fixture: Awaited<ReturnType<typeof seedTree>>) {
    const { retryRunId } = await seedParkedWorkspaceBusyRetry(fixture);
    const pause = await request(app).post(`/api/issues/${fixture.parentId}/tree-holds`).send({ mode: "pause" });
    expect(pause.status).toBe(201);
    await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(Date.now() - 1_000) })
      .where(eq(heartbeatRuns.id, retryRunId));
    await heartbeat.promoteDueScheduledRetries(new Date());
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const [suppressed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retryRunId));
    expect(suppressed).toMatchObject({ status: "cancelled", errorCode: "issue_paused" });
    return { retryRunId, holdId: pause.body.hold.id as string };
  }

  async function expectResumedOnce(childId: string, holdId: string, interruptedRunId: string) {
    const resumed = (await childRuns(childId)).filter((run) => run.contextSnapshot?.wakeReason === "issue_tree_resumed");
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({ status: "succeeded" });
    expect(resumed[0]!.contextSnapshot).toMatchObject({ holdId, interruptedRunId });
    expect(executedRunIds).toEqual([resumed[0]!.id]);
  }

  it("resumes a refused retry on a task moved out of the paused tree before release", async () => {
    const fixture = await seedTree();
    const { retryRunId, holdId } = await pauseAndSuppressRetry(fixture);
    await db.update(issues).set({ parentId: null }).where(eq(issues.id, fixture.childId));

    const release = await request(app).post(`/api/issues/${fixture.parentId}/tree-holds/${holdId}/release`).send({});
    expect(release.status).toBe(200);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await expectResumedOnce(fixture.childId, holdId, retryRunId);
  });

  it("resumes a refused retry on a task outside the snapshot when release also wakes members", async () => {
    const fixture = await seedTree();
    // The parent is user-assigned, so wakeAgents has no member to wake; the
    // child joins the tree after the snapshot.
    await db.update(issues).set({ parentId: null }).where(eq(issues.id, fixture.childId));
    const pause = await request(app).post(`/api/issues/${fixture.parentId}/tree-holds`).send({ mode: "pause" });
    expect(pause.status).toBe(201);
    const holdId = pause.body.hold.id as string;
    expect(pause.body.hold.members.map((member: { issueId: string }) => member.issueId)).not.toContain(fixture.childId);
    await db.update(issues).set({ parentId: fixture.parentId }).where(eq(issues.id, fixture.childId));
    const { retryRunId } = await seedParkedWorkspaceBusyRetry(fixture);
    await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(Date.now() - 1_000) })
      .where(eq(heartbeatRuns.id, retryRunId));
    await heartbeat.promoteDueScheduledRetries(new Date());
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const [suppressed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retryRunId));
    expect(suppressed).toMatchObject({ status: "cancelled", errorCode: "issue_paused" });

    const release = await request(app).post(`/api/issues/${fixture.parentId}/tree-holds/${holdId}/release`)
      .send({ metadata: { wakeAgents: true } });
    expect(release.status).toBe(200);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await expectResumedOnce(fixture.childId, holdId, retryRunId);
  });

  it("resumes a task added after overlapping snapshots once the last covering pause is released", async () => {
    const fixture = await seedTree();
    const midId = randomUUID();
    await db.insert(issues).values({ id: midId, companyId: fixture.companyId, parentId: fixture.parentId, title: "Mid",
      status: "in_progress", priority: "medium", responsibleUserId: "responsible-user", assigneeUserId: "responsible-user",
      issueNumber: 3, identifier: `${fixture.prefix}-3` });
    await db.update(issues).set({ parentId: null }).where(eq(issues.id, fixture.childId));
    const outer = await request(app).post(`/api/issues/${fixture.parentId}/tree-holds`).send({ mode: "pause" });
    const inner = await request(app).post(`/api/issues/${midId}/tree-holds`).send({ mode: "pause" });
    expect([outer.status, inner.status]).toEqual([201, 201]);
    // The task joins under both pauses after their snapshots; the nearer pause refuses its retry.
    await db.update(issues).set({ parentId: midId }).where(eq(issues.id, fixture.childId));
    const { retryRunId } = await seedParkedWorkspaceBusyRetry(fixture);
    await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(Date.now() - 1_000) })
      .where(eq(heartbeatRuns.id, retryRunId));
    await heartbeat.promoteDueScheduledRetries(new Date());
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const [suppressed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retryRunId));
    expect(suppressed!.resultJson).toMatchObject({ treeHoldSuppression: { holdId: inner.body.hold.id } });

    const innerRelease = await request(app).post(`/api/issues/${midId}/tree-holds/${inner.body.hold.id}/release`).send({});
    expect(innerRelease.status).toBe(200);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(executedRunIds).toEqual([]);

    const outerRelease = await request(app)
      .post(`/api/issues/${fixture.parentId}/tree-holds/${outer.body.hold.id}/release`).send({});
    expect(outerRelease.status).toBe(200);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await expectResumedOnce(fixture.childId, inner.body.hold.id, retryRunId);
  });

  it("leaves a due retry parked when the pause is released while the gate refuses it", async () => {
    const fixture = await seedTree();
    const { retryRunId } = await seedParkedWorkspaceBusyRetry(fixture);
    const pause = await request(app).post(`/api/issues/${fixture.parentId}/tree-holds`).send({ mode: "pause" });
    expect(pause.status).toBe(201);
    const holdId = pause.body.hold.id as string;
    await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(Date.now() - 1_000) })
      .where(eq(heartbeatRuns.id, retryRunId));

    // A release has written but not committed when the gate reads the pause.
    let commitRelease!: () => void;
    const releaseCommitted = new Promise<void>((resolve) => { commitRelease = resolve; });
    let releaseWritten!: () => void;
    const written = new Promise<void>((resolve) => { releaseWritten = resolve; });
    const release = db.transaction(async (tx) => {
      await tx.update(issueTreeHolds).set({ status: "released", releasedAt: new Date() })
        .where(eq(issueTreeHolds.id, holdId));
      releaseWritten();
      await releaseCommitted;
    });
    await written;
    const promotion = heartbeat.promoteDueScheduledRetries(new Date());
    // Wait until the gate, having seen the pause, waits on the uncommitted release.
    let waiting = false;
    for (let attempt = 0; attempt < 200 && !waiting; attempt += 1) {
      const rows = await db.execute(sql`select 1 from pg_locks where not granted limit 1`);
      waiting = (rows as unknown as unknown[]).length > 0;
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(waiting).toBe(true);
    commitRelease();
    await release;
    await promotion;

    // The gate did not cancel the retry under a pause that no longer exists;
    // the retry runs as ordinary work, once.
    const [afterGate] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retryRunId));
    expect(afterGate!.status).not.toBe("cancelled");
    await heartbeat.promoteDueScheduledRetries(new Date());
    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const [ran] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retryRunId));
    expect(ran).toMatchObject({ status: "succeeded" });
    expect(executedRunIds).toEqual([retryRunId]);
  });

  it("resumes work a gate refused after the release that should have resumed it had finished", async () => {
    const fixture = await seedTree();
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, fixture.childId));
    const pause = await request(app).post(`/api/issues/${fixture.parentId}/tree-holds`).send({ mode: "pause" });
    expect(pause.status).toBe(201);
    const holdId = pause.body.hold.id as string;
    const release = await request(app).post(`/api/issues/${fixture.parentId}/tree-holds/${holdId}/release`).send({});
    expect(release.status).toBe(200);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(await childRuns(fixture.childId)).toEqual([]);

    // The claim gate read the pause before release and saved its refusal after.
    const refusedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: refusedRunId, companyId: fixture.companyId, agentId: fixture.agentId,
      invocationSource: "assignment", triggerDetail: "system", status: "cancelled", errorCode: "issue_paused",
      finishedAt: new Date(), resultJson: { treeHoldSuppression: { holdId, rootIssueId: fixture.parentId } },
      contextSnapshot: { issueId: fixture.childId, taskId: fixture.childId, wakeReason: "issue_assigned" } });
    const { resumeIfPauseAlreadyReleased } = await import("../services/issue-tree-resume.js");
    const wakeup = (agentId: string, opts: Parameters<typeof heartbeat.wakeup>[1]) => heartbeat.wakeup(agentId, opts);
    expect(await resumeIfPauseAlreadyReleased(db, { companyId: fixture.companyId, issueId: fixture.childId, holdId, wakeup }))
      .toEqual([]);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    // A repeated check cannot dispatch the same work twice.
    await resumeIfPauseAlreadyReleased(db, { companyId: fixture.companyId, issueId: fixture.childId, holdId, wakeup });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await expectResumedOnce(fixture.childId, holdId, refusedRunId);
  });

  it("does not resume a paused-code cancellation that no pause hold covered", async () => {
    const fixture = await seedTree();
    const { retryRunId } = await seedParkedWorkspaceBusyRetry(fixture);
    // A suppressed run with the pause error code but no covering pause owes nothing.
    await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "issue_paused", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, retryRunId));
    const { resumePauseInterruptedWork } = await import("../services/issue-tree-resume.js");
    expect(await resumePauseInterruptedWork(db, {
      companyId: fixture.companyId, issueIds: [fixture.childId], actor: { actorType: "system", actorId: "system" },
      wakeup: (agentId, opts) => heartbeat.wakeup(agentId, opts),
    })).toEqual([]);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(await childRuns(fixture.childId)).toHaveLength(2);
    expect(executedRunIds).toEqual([]);
  });

  it("does not resume work the board reassigned while the tree was paused", async () => {
    const fixture = await seedTree();
    const prepared = new Promise<void>((resolve) => { preparationGate.reached = resolve; });
    preparationGate.blockNext = true;
    await wakeChild(fixture);
    await prepared;

    await pauseAndRelease(fixture, {
      afterPause: async () => { preparationGate.release?.(); },
      whilePaused: async () => {
        await db.update(issues).set({ assigneeAgentId: null, assigneeUserId: "responsible-user" })
          .where(eq(issues.id, fixture.childId));
      },
    });

    expect((await childRuns(fixture.childId)).map((run) => run.status)).toEqual(["cancelled"]);
    expect(executedRunIds).toEqual([]);
  });

  it("keeps an uncertain mid-turn Stop held for reconciliation instead of replaying it on release", async () => {
    const fixture = await seedTree();
    const entered = new Promise<void>((resolve) => { adapterGate.entered = resolve; });
    adapterGate.block = true;
    const run = await wakeChild(fixture);
    await entered;

    await pauseAndRelease(fixture, { whilePaused: async () => { adapterGate.block = false; } });

    const runs = await childRuns(fixture.childId);
    expect(runs.map((row) => row.id)).toEqual([run!.id]);
    expect(runs[0]).toMatchObject({ status: "cancelled" });
    expect(await getExecutionBlocker(db, fixture.companyId, fixture.childId))
      .toMatchObject({ cause: "legacy_execution_requires_reconciliation", runId: run!.id });
    const skipped = await db.select().from(activityLog).where(eq(activityLog.action, "issue.tree_resume_wake_skipped"));
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.details).toMatchObject({ interruptedRunId: run!.id, cause: "legacy_execution_requires_reconciliation" });
  });
});
