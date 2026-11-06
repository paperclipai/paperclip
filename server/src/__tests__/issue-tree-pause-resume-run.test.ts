import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
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
