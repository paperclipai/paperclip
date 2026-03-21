import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  applyPendingMigrations,
  companies,
  companyMemberships,
  createDb,
  ensurePostgresDatabase,
  heartbeatRunEvents,
  heartbeatRuns,
  instanceSettings,
  issues,
  principalPermissionGrants,
  projects,
  routineRuns,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { accessService } from "../services/access.js";

vi.mock("../services/index.js", async () => {
  const actual = await vi.importActual<typeof import("../services/index.js")>("../services/index.js");
  const { randomUUID } = await import("node:crypto");
  const { eq } = await import("drizzle-orm");
  const { heartbeatRuns, issues } = await import("@paperclipai/db");

  return {
    ...actual,
    routineService: (db: any) =>
      actual.routineService(db, {
        heartbeat: {
          wakeup: async (agentId: string, wakeupOpts: any) => {
            const issueId =
              (typeof wakeupOpts?.payload?.issueId === "string" && wakeupOpts.payload.issueId) ||
              (typeof wakeupOpts?.contextSnapshot?.issueId === "string" && wakeupOpts.contextSnapshot.issueId) ||
              null;
            if (!issueId) return null;

            const issue = await db
              .select({ companyId: issues.companyId })
              .from(issues)
              .where(eq(issues.id, issueId))
              .then((rows: Array<{ companyId: string }>) => rows[0] ?? null);
            if (!issue) return null;

            const queuedRunId = randomUUID();
            await db.insert(heartbeatRuns).values({
              id: queuedRunId,
              companyId: issue.companyId,
              agentId,
              invocationSource: wakeupOpts?.source ?? "assignment",
              triggerDetail: wakeupOpts?.triggerDetail ?? null,
              status: "queued",
              contextSnapshot: { ...(wakeupOpts?.contextSnapshot ?? {}), issueId },
            });
            await db
              .update(issues)
              .set({
                executionRunId: queuedRunId,
                executionLockedAt: new Date(),
              })
              .where(eq(issues.id, issueId));
            return { id: queuedRunId };
          },
        },
      }),
  };
});

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  return mod.default as EmbeddedPostgresCtor;
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function startTempDatabase() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-routines-e2e-"));
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: () => {},
  });
  await instance.initialise();
  await instance.start();

  const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminConnectionString, "paperclip");
  const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
  await applyPendingMigrations(connectionString);
  return { connectionString, dataDir, instance };
}

describe("routine routes end-to-end", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(routines);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  async function createApp(actor: Record<string, unknown>) {
    const { routineRoutes } = await import("../routes/routines.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", routineRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const userId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
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

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Routine Project",
      status: "in_progress",
    });

    const access = accessService(db);
    const membership = await access.ensureMembership(companyId, "user", userId, "owner", "active");
    await access.setMemberPermissions(
      companyId,
      membership.id,
      [{ permissionKey: "tasks:assign" }],
      userId,
    );

    return { companyId, agentId, projectId, userId };
  }

  it("supports creating, scheduling, and manually running a routine through the API", async () => {
    const { companyId, agentId, projectId, userId } = await seedFixture();
    const app = await createApp({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const createRes = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        projectId,
        title: "Daily standup prep",
        description: "Summarize blockers and open PRs",
        assigneeAgentId: agentId,
        priority: "high",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.title).toBe("Daily standup prep");
    expect(createRes.body.assigneeAgentId).toBe(agentId);

    const routineId = createRes.body.id as string;

    const triggerRes = await request(app)
      .post(`/api/routines/${routineId}/triggers`)
      .send({
        kind: "schedule",
        label: "Weekday morning",
        cronExpression: "0 10 * * 1-5",
        timezone: "UTC",
      });

    expect(triggerRes.status).toBe(201);
    expect(triggerRes.body.trigger.kind).toBe("schedule");
    expect(triggerRes.body.trigger.enabled).toBe(true);
    expect(triggerRes.body.secretMaterial).toBeNull();

    const runRes = await request(app)
      .post(`/api/routines/${routineId}/run`)
      .send({
        source: "manual",
        payload: { origin: "e2e-test" },
      });

    expect(runRes.status).toBe(202);
    expect(runRes.body.status).toBe("issue_created");
    expect(runRes.body.source).toBe("manual");
    expect(runRes.body.linkedIssueId).toBeTruthy();

    const detailRes = await request(app).get(`/api/routines/${routineId}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.triggers).toHaveLength(1);
    expect(detailRes.body.triggers[0]?.id).toBe(triggerRes.body.trigger.id);
    expect(detailRes.body.recentRuns).toHaveLength(1);
    expect(detailRes.body.recentRuns[0]?.id).toBe(runRes.body.id);
    expect(detailRes.body.activeIssue?.id).toBe(runRes.body.linkedIssueId);

    const runsRes = await request(app).get(`/api/routines/${routineId}/runs?limit=10`);
    expect(runsRes.status).toBe(200);
    expect(runsRes.body).toHaveLength(1);
    expect(runsRes.body[0]?.id).toBe(runRes.body.id);

    const [issue] = await db
      .select({
        id: issues.id,
        originId: issues.originId,
        originKind: issues.originKind,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, runRes.body.linkedIssueId));

    expect(issue).toMatchObject({
      id: runRes.body.linkedIssueId,
      originId: routineId,
      originKind: "routine_execution",
    });
    expect(issue?.executionRunId).toBeTruthy();

    const actions = await db
      .select({
        action: activityLog.action,
      })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId));

    expect(actions.map((entry) => entry.action)).toEqual(
      expect.arrayContaining([
        "routine.created",
        "routine.trigger_created",
        "routine.run_triggered",
      ]),
    );
  });
});
