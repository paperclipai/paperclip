import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companySecretBindings,
  companySecrets,
  companySecretVersions,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issues,
  projects,
  routineRevisions,
  routineRuns,
  routines,
  routineTriggers,
  secretAccessEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { routineService } from "../services/routines.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const originalPaperclipApiUrlEnv = process.env.PAPERCLIP_API_URL;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routine dispatch pool tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SETTLE_TIMEOUT_MS = 15_000;

type TestDb = ReturnType<typeof createDb>;
type Wakeup = (input: { db: TestDb; agentId: string; issueId: string }) => Promise<unknown>;

async function settled<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Routine dispatch did not settle within ${SETTLE_TIMEOUT_MS}ms`)),
      SETTLE_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

describeEmbeddedPostgres("routine dispatch on a bounded connection pool", () => {
  let adminDb!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const pools: TestDb[] = [];

  beforeAll(async () => {
    process.env.PAPERCLIP_API_URL = "http://localhost:3100";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routines-dispatch-pool-");
    adminDb = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.$client.end({ timeout: 0 })));
    await adminDb.delete(activityLog);
    await adminDb.delete(secretAccessEvents);
    await adminDb.delete(companySecretBindings);
    await adminDb.delete(routineRuns);
    await adminDb.delete(routineTriggers);
    await adminDb.delete(routineRevisions);
    await adminDb.delete(routines);
    await adminDb.delete(companySecretVersions);
    await adminDb.delete(companySecrets);
    await adminDb.delete(issues);
    await adminDb.delete(heartbeatRuns);
    await adminDb.delete(projects);
    await adminDb.delete(agents);
    await adminDb.delete(companies);
    await adminDb.delete(instanceSettings);
  });

  afterAll(async () => {
    await adminDb?.$client.end({ timeout: 0 });
    await tempDb?.cleanup();
    if (originalPaperclipApiUrlEnv === undefined) delete process.env.PAPERCLIP_API_URL;
    else process.env.PAPERCLIP_API_URL = originalPaperclipApiUrlEnv;
  });

  async function linkQueuedRun(input: { db: TestDb; companyId: string; agentId: string; issueId: string }) {
    const runId = randomUUID();
    await input.db.transaction(async (tx) => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, input.issueId)).for("update");
      await tx.insert(heartbeatRuns).values({
        id: runId,
        companyId: input.companyId,
        agentId: input.agentId,
        invocationSource: "assignment",
        status: "queued",
        contextSnapshot: { issueId: input.issueId },
      });
      await tx
        .update(issues)
        .set({ executionRunId: runId, executionLockedAt: new Date() })
        .where(eq(issues.id, input.issueId));
    });
    return { id: runId };
  }

  async function seedFixture(opts: {
    maxConnections: number;
    parentIssue?: boolean;
    agentAuthored?: boolean;
    wakeup?: Wakeup;
  }) {
    const db = createDb(tempDb!.connectionString, { maxConnections: opts.maxConnections });
    pools.push(db);
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    await adminDb.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: randomUUID(),
      requireBoardApprovalForNewAgents: false,
    });
    await adminDb.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await adminDb.insert(projects).values({ id: projectId, companyId, name: "Routines", status: "in_progress" });
    const parentIssueId = opts.parentIssue ? randomUUID() : null;
    if (parentIssueId) {
      await adminDb.insert(issues).values({
        id: parentIssueId,
        companyId,
        projectId,
        title: "Parent",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      });
    }
    const svc = routineService(db, {
      heartbeat: {
        wakeup: async (wakeupAgentId, wakeupOpts) => {
          const issueId = typeof wakeupOpts.payload?.issueId === "string" ? wakeupOpts.payload.issueId : null;
          if (!issueId) return null;
          if (opts.wakeup) return opts.wakeup({ db, agentId: wakeupAgentId, issueId });
          return linkQueuedRun({ db, companyId, agentId: wakeupAgentId, issueId });
        },
      },
    });
    const createRoutine = (title: string, concurrencyPolicy: "coalesce_if_active" | "always_enqueue") => svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId,
        title,
        description: "Run the routine",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy,
        catchUpPolicy: "skip_missed",
        variables: [],
      },
      opts.agentAuthored ? { agentId } : {},
    );
    const routine = await createRoutine("ascii frog", "coalesce_if_active");
    const routineIssues = () => adminDb.select().from(issues).where(eq(issues.originId, routine.id));
    return { db, svc, routine, companyId, agentId, createRoutine, routineIssues };
  }

  async function createWebhookTrigger(
    f: Awaited<ReturnType<typeof seedFixture>>,
    signingMode: "none" | "bearer",
  ) {
    return f.svc.createTrigger(
      f.routine.id,
      { kind: "webhook", enabled: true, signingMode, replayWindowSec: 300 },
      { userId: "board-user" },
    );
  }

  it("dispatches an unsigned public trigger delivery when the pool has one connection", async () => {
    const f = await seedFixture({ maxConnections: 1 });
    const { trigger } = await createWebhookTrigger(f, "none");

    const run = await settled(f.svc.firePublicTrigger(trigger.publicId!, { payload: {} }));

    expect(run).toMatchObject({ status: "issue_created", source: "webhook" });
    const created = await f.routineIssues();
    expect(created).toHaveLength(1);
    expect(created[0]!.executionRunId).toBeTruthy();
  }, 30_000);

  it("authenticates a signed public trigger delivery when the pool has one connection", async () => {
    const f = await seedFixture({ maxConnections: 1 });
    const { trigger, secretMaterial } = await createWebhookTrigger(f, "bearer");

    const run = await settled(f.svc.firePublicTrigger(trigger.publicId!, {
      authorizationHeader: `Bearer ${secretMaterial!.webhookSecret}`,
      payload: {},
    }));

    expect(run).toMatchObject({ status: "issue_created", source: "webhook" });
    await expect(settled(f.svc.firePublicTrigger(trigger.publicId!, {
      authorizationHeader: "Bearer wrong",
      payload: {},
    }))).rejects.toMatchObject({ status: 401 });
    const events = await adminDb.select().from(secretAccessEvents).where(eq(secretAccessEvents.companyId, f.companyId));
    expect(events.map((event) => event.outcome)).toEqual(["success", "success"]);
  }, 30_000);

  it("dispatches an agent-authored routine that has a parent task", async () => {
    const f = await seedFixture({ maxConnections: 10, parentIssue: true, agentAuthored: true });

    const run = await settled(f.svc.runRoutine(f.routine.id, { source: "api" }, {}));

    expect(run.status).toBe("issue_created");
    expect(await f.routineIssues()).toHaveLength(1);
  }, 30_000);

  it("coalesces concurrent deliveries for one routine that outnumber the pool", async () => {
    const f = await seedFixture({ maxConnections: 2 });
    const { trigger } = await createWebhookTrigger(f, "none");

    const runs = await settled(Promise.all(
      Array.from({ length: 6 }, () => f.svc.firePublicTrigger(trigger.publicId!, { payload: {} })),
    ));

    const statuses = runs.map((run) => ("status" in run ? run.status : null)).sort();
    expect(statuses).toEqual(["coalesced", "coalesced", "coalesced", "coalesced", "coalesced", "issue_created"]);
    expect(await f.routineIssues()).toHaveLength(1);
  }, 30_000);

  it("dispatches as many distinct routines at once as the pool has connections", async () => {
    const f = await seedFixture({ maxConnections: 2 });
    const others = [
      await f.createRoutine("first", "always_enqueue"),
      await f.createRoutine("second", "always_enqueue"),
    ];

    const runs = await settled(Promise.all(
      others.map((routine) => f.svc.runRoutine(routine.id, { source: "api" }, {})),
    ));

    expect(runs.map((run) => run.status)).toEqual(["issue_created", "issue_created"]);
  }, 30_000);

  it("fails the run and removes the task when the wakeup is rejected", async () => {
    const f = await seedFixture({
      maxConnections: 1,
      wakeup: async () => {
        throw new Error("queue unavailable");
      },
    });

    const run = await settled(f.svc.runRoutine(f.routine.id, { source: "api" }, {}));

    expect(run).toMatchObject({ status: "failed", failureReason: "queue unavailable", linkedIssueId: null });
    expect(await f.routineIssues()).toEqual([]);
  }, 30_000);

  it("coalesces into the task that won the execution slot while the wakeup was queued", async () => {
    let winnerIssueId: string | null = null;
    const f = await seedFixture({
      maxConnections: 1,
      wakeup: async ({ db, agentId, issueId }) => {
        const [loser] = await adminDb.select().from(issues).where(eq(issues.id, issueId));
        winnerIssueId = randomUUID();
        await adminDb.insert(issues).values({
          id: winnerIssueId,
          companyId: loser!.companyId,
          projectId: loser!.projectId,
          title: loser!.title,
          status: "todo",
          priority: "medium",
          assigneeAgentId: agentId,
          originKind: loser!.originKind,
          originId: loser!.originId,
          originRunId: randomUUID(),
          originFingerprint: loser!.originFingerprint,
        });
        await linkQueuedRun({ db: adminDb, companyId: loser!.companyId, agentId, issueId: winnerIssueId });
        return linkQueuedRun({ db, companyId: loser!.companyId, agentId, issueId });
      },
    });

    const run = await settled(f.svc.runRoutine(f.routine.id, { source: "api" }, {}));

    expect(run).toMatchObject({ status: "coalesced", linkedIssueId: winnerIssueId });
    expect((await f.routineIssues()).map((issue) => issue.id)).toEqual([winnerIssueId]);
  }, 30_000);

  it("fails the run instead of coalescing into its own task when the slot holder is not live", async () => {
    let holderIssueId: string | null = null;
    const f = await seedFixture({
      maxConnections: 1,
      wakeup: async ({ db, agentId, issueId }) => {
        const [loser] = await adminDb.select().from(issues).where(eq(issues.id, issueId));
        holderIssueId = randomUUID();
        await adminDb.insert(issues).values({
          id: holderIssueId,
          companyId: loser!.companyId,
          projectId: loser!.projectId,
          title: loser!.title,
          status: "todo",
          priority: "medium",
          assigneeAgentId: agentId,
          originKind: loser!.originKind,
          originId: loser!.originId,
          originRunId: randomUUID(),
          originFingerprint: loser!.originFingerprint,
        });
        const holderRun = await linkQueuedRun({ db: adminDb, companyId: loser!.companyId, agentId, issueId: holderIssueId });
        await adminDb.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, holderRun.id));
        await adminDb.insert(heartbeatRuns).values({
          companyId: loser!.companyId,
          agentId,
          invocationSource: "assignment",
          status: "queued",
          contextSnapshot: { issueId },
        });
        return linkQueuedRun({ db, companyId: loser!.companyId, agentId, issueId });
      },
    });

    const run = await settled(f.svc.runRoutine(f.routine.id, { source: "api" }, {}));

    expect(run).toMatchObject({ status: "failed", linkedIssueId: null });
    expect((await f.routineIssues()).map((issue) => issue.id)).toEqual([holderIssueId]);
  }, 30_000);

  it("records the run only after the wakeup is queued", async () => {
    let runsDuringWakeup: number | null = null;
    const f = await seedFixture({
      maxConnections: 1,
      wakeup: async ({ db, agentId, issueId }) => {
        const [issue] = await adminDb.select().from(issues).where(eq(issues.id, issueId));
        runsDuringWakeup = (await adminDb.select().from(routineRuns).where(eq(routineRuns.routineId, f.routine.id))).length;
        return linkQueuedRun({ db, companyId: issue!.companyId, agentId, issueId });
      },
    });

    const run = await settled(f.svc.runRoutine(f.routine.id, { source: "api" }, {}));

    expect(runsDuringWakeup).toBe(0);
    const [created] = await f.routineIssues();
    expect(run).toMatchObject({ id: created!.originRunId, status: "issue_created", linkedIssueId: created!.id });
  }, 30_000);

  it("waits while another server process dispatches the same routine", async () => {
    const f = await seedFixture({ maxConnections: 1 });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired!: () => void;
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const otherProcess = adminDb.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`routine_dispatch:${f.routine.id}`}, 0))`,
      );
      acquired();
      await held;
    });
    await locked;

    const dispatch = f.svc.runRoutine(f.routine.id, { source: "api" }, {});
    const early = await Promise.race([
      dispatch.then(() => "settled" as const),
      new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 500)),
    ]);
    expect(early).toBe("waiting");
    expect(await f.routineIssues()).toEqual([]);

    release();
    await otherProcess;
    expect((await settled(dispatch)).status).toBe("issue_created");
  }, 30_000);

  it("keeps the dispatch lock while the wakeup outlasts the idle-in-transaction timeout", async () => {
    const [{ name }] = await adminDb.execute<{ name: string }>(sql`select current_user as name`);
    const role = sql.identifier(String(name));
    await adminDb.execute(sql`alter role ${role} set idle_in_transaction_session_timeout = '1s'`);
    try {
      const f = await seedFixture({
        maxConnections: 1,
        wakeup: async ({ db, agentId, issueId }) => {
          await new Promise((resolve) => setTimeout(resolve, 2_500));
          return linkQueuedRun({ db, companyId: f.companyId, agentId, issueId });
        },
      });

      const run = await settled(f.svc.runRoutine(f.routine.id, { source: "api" }, {}));

      expect(run.status).toBe("issue_created");
      expect(await f.routineIssues()).toHaveLength(1);
    } finally {
      await adminDb.execute(sql`alter role ${role} reset idle_in_transaction_session_timeout`);
    }
  }, 30_000);

  it("records the run when its trigger is deleted while the wakeup is queued", async () => {
    let triggerId: string | null = null;
    const f = await seedFixture({
      maxConnections: 1,
      wakeup: async ({ db, agentId, issueId }) => {
        await adminDb.delete(routineTriggers).where(eq(routineTriggers.id, triggerId!));
        return linkQueuedRun({ db, companyId: f.companyId, agentId, issueId });
      },
    });
    const { trigger } = await createWebhookTrigger(f, "none");
    triggerId = trigger.id;

    const run = await settled(f.svc.firePublicTrigger(trigger.publicId!, { payload: {} }));

    expect(run).toMatchObject({ status: "issue_created", source: "webhook", triggerId: null });
    const created = await f.routineIssues();
    expect(created).toHaveLength(1);
    expect(run).toMatchObject({ id: created[0]!.originRunId, linkedIssueId: created[0]!.id });
  }, 30_000);
});
