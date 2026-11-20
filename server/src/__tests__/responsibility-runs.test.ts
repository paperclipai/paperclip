import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
  projects,
  responsibilities,
  responsibilityLinks,
  routineRuns,
  routines,
} from "@paperclipai/db";
import { RESPONSIBILITY_RECENT_RUNS_MAX_LIMIT } from "@paperclipai/shared";
import { errorHandler } from "../middleware/index.js";
import { responsibilityBarRoutes } from "../routes/responsibility-bars.js";
import { responsibilityMetricRoutes } from "../routes/responsibility-metrics.js";
import { responsibilityRoutes } from "../routes/responsibilities.js";
import { responsibilityRunRoutes } from "../routes/responsibility-runs.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import type { IssueAssignmentWakeupDeps } from "../services/issue-assignment-wakeup.js";
import { clampRecentRunsLimit } from "../services/responsibility-runs.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const externalDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_RESPONSIBILITY_RUNS_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;
type Actor = Express.Request["actor"];

const OWNER = "board-user";
const OTHER = "other-user";
const MINUTE_MS = 60_000;

function localBoardActor(): Actor {
  return { type: "board", userId: OWNER, source: "local_implicit", isInstanceAdmin: true };
}

function sessionBoardActor(companyId: string, userId: string, role = "operator"): Actor {
  return {
    type: "board",
    userId,
    source: "session",
    sessionId: `session-${userId}`,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: role, status: "active" }],
    isInstanceAdmin: false,
  };
}

function agentActor(companyId: string, agentId: string): Actor {
  return { type: "agent", companyId, agentId, source: "agent_jwt" };
}

describe("clampRecentRunsLimit", () => {
  it("defaults to 8 and stays between 1 and the maximum", () => {
    expect(clampRecentRunsLimit(undefined)).toBe(8);
    expect(clampRecentRunsLimit("nope")).toBe(8);
    expect(clampRecentRunsLimit("3")).toBe(3);
    expect(clampRecentRunsLimit("0")).toBe(1);
    expect(clampRecentRunsLimit("500")).toBe(RESPONSIBILITY_RECENT_RUNS_MAX_LIMIT);
  });
});

describeEmbeddedPostgres("a responsibility's recent runs", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    if (!externalDatabaseUrl) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-responsibility-runs-");
    db = createDb(externalDatabaseUrl ?? tempDb!.connectionString, { maxConnections: 6 });
  }, 30_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    await instanceSettingsService(db).updateExperimental({ enableResponsibilities: true });
  });

  function createApp(actor: Actor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    const heartbeat: IssueAssignmentWakeupDeps = { wakeup: vi.fn(async () => ({ queued: true })) as unknown as IssueAssignmentWakeupDeps["wakeup"] };
    app.use("/api", responsibilityRoutes(db, { heartbeat }));
    app.use("/api", responsibilityBarRoutes(db, { heartbeat }));
    app.use("/api", responsibilityMetricRoutes(db));
    app.use("/api", responsibilityRunRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seed() {
    const company = await db.insert(companies)
      .values({ name: "Runs Co", issuePrefix: `R${randomUUID().replace(/[^A-Z0-9]/gi, "").slice(0, 6).toUpperCase()}` })
      .returning().then((rows) => rows[0]!);
    await db.insert(companyMemberships).values([
      { companyId: company.id, principalType: "user", principalId: OWNER, status: "active", membershipRole: "owner" },
      { companyId: company.id, principalType: "user", principalId: OTHER, status: "active", membershipRole: "operator" },
    ]);
    const [ceo, analyst] = await db.insert(agents).values([
      { companyId: company.id, name: "Chief", role: "ceo", status: "idle", adapterType: "codex_local", adapterConfig: {} },
      { companyId: company.id, name: "Analyst", role: "general", status: "idle", adapterType: "codex_local", adapterConfig: {} },
    ]).returning();
    const app = createApp(localBoardActor());
    const created = await request(app).post(`/api/companies/${company.id}/responsibilities`).send({
      title: "Fundraising", standard: "We talk to enough investors", metricName: "Investors contacted", metricTarget: 20,
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const [project] = await db.insert(projects).values({ companyId: company.id, name: "Deck", status: "in_progress" }).returning();
    const [routine] = await db.insert(routines).values({ companyId: company.id, title: "Weekly pipeline review", assigneeAgentId: analyst!.id }).returning();
    const [direct, inProject, fromRoutine, elsewhere, hidden] = await db.insert(issues).values([
      { companyId: company.id, title: "Draft the update", status: "in_progress", priority: "medium", assigneeAgentId: analyst!.id },
      { companyId: company.id, title: "Fix slide 4", status: "todo", priority: "medium", projectId: project!.id },
      { companyId: company.id, title: "Weekly pipeline review", status: "done", priority: "medium", assigneeAgentId: analyst!.id },
      { companyId: company.id, title: "Unrelated", status: "todo", priority: "medium" },
      { companyId: company.id, title: "Hidden", status: "todo", priority: "medium", hiddenAt: new Date() },
    ]).returning();
    await db.insert(responsibilityLinks).values([
      { companyId: company.id, responsibilityId: id, issueId: direct!.id },
      { companyId: company.id, responsibilityId: id, issueId: hidden!.id },
      { companyId: company.id, responsibilityId: id, projectId: project!.id },
      { companyId: company.id, responsibilityId: id, routineId: routine!.id },
    ]);
    await db.insert(routineRuns).values({ companyId: company.id, routineId: routine!.id, source: "schedule", status: "issue_created", linkedIssueId: fromRoutine!.id });
    return { company, ceo: ceo!, analyst: analyst!, app, id, issues: { direct: direct!, inProject: inProject!, fromRoutine: fromRoutine!, elsewhere: elsewhere!, hidden: hidden! }, routine: routine! };
  }

  async function run(seeded: Awaited<ReturnType<typeof seed>>, issueId: string, minutesAgo: number, status = "succeeded", agentId = seeded.analyst.id) {
    const at = new Date(Date.now() - minutesAgo * MINUTE_MS);
    const [row] = await db.insert(heartbeatRuns).values({
      companyId: seeded.company.id, agentId, scopeKind: "issue", issueId, status, createdAt: at, startedAt: at,
      finishedAt: status === "running" ? null : new Date(at.getTime() + MINUTE_MS),
    }).returning();
    return row!;
  }

  const read = (app: express.Express, id: string, query = "") => request(app).get(`/api/responsibilities/${id}/runs${query}`);

  it("lists runs on its tasks, its projects' tasks and its routines' tasks, newest first, and nothing else", async () => {
    const seeded = await seed();
    const oldest = await run(seeded, seeded.issues.direct.id, 50);
    const project = await run(seeded, seeded.issues.inProject.id, 30, "failed", seeded.ceo.id);
    const routine = await run(seeded, seeded.issues.fromRoutine.id, 20);
    const live = await run(seeded, seeded.issues.direct.id, 5, "running");
    await run(seeded, seeded.issues.elsewhere.id, 1);
    await run(seeded, seeded.issues.hidden.id, 2);
    const res = await read(seeded.app, seeded.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ responsibilityId: seeded.id, limit: 8 });
    expect(res.body.runs.map((entry: { id: string }) => entry.id)).toEqual([live.id, routine.id, project.id, oldest.id]);
    expect(res.body.runs[0]).toMatchObject({ agentId: seeded.analyst.id, status: "running", finishedAt: null, issue: { id: seeded.issues.direct.id, title: "Draft the update" }, routineId: null });
    expect(res.body.runs[1]).toMatchObject({ issue: { id: seeded.issues.fromRoutine.id }, routineId: seeded.routine.id });
    expect(res.body.runs[2]).toMatchObject({ agentId: seeded.ceo.id, status: "failed" });
  });

  it("caps the list at the limit asked for, 8 by default", async () => {
    const seeded = await seed();
    for (let index = 0; index < 10; index += 1) await run(seeded, seeded.issues.direct.id, 100 - index);
    const res = await read(seeded.app, seeded.id);
    expect(res.body.runs).toHaveLength(8);
    const times = res.body.runs.map((entry: { createdAt: string }) => entry.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
    expect((await read(seeded.app, seeded.id, "?limit=3")).body.runs).toHaveLength(3);
    expect((await read(seeded.app, seeded.id, "?limit=999")).body.limit).toBe(RESPONSIBILITY_RECENT_RUNS_MAX_LIMIT);
  });

  it("follows the detail route's access, and is 404 with the flag off", async () => {
    const seeded = await seed();
    await run(seeded, seeded.issues.direct.id, 5);
    // A teammate and an agent in the company read it, as they read the detail.
    expect((await read(createApp(sessionBoardActor(seeded.company.id, OTHER)), seeded.id)).status).toBe(200);
    expect((await read(createApp(agentActor(seeded.company.id, seeded.ceo.id)), seeded.id)).status).toBe(200);
    // Another company's board user gets what the detail route gives them.
    const outsider = createApp(sessionBoardActor(randomUUID(), OTHER));
    const detail = await request(outsider).get(`/api/responsibilities/${seeded.id}`);
    expect(detail.status).toBe(404);
    expect((await read(outsider, seeded.id)).status).toBe(detail.status);
    expect((await read(seeded.app, randomUUID())).status).toBe(404);
    await instanceSettingsService(db).updateExperimental({ enableResponsibilities: false });
    expect((await read(seeded.app, seeded.id)).status).toBe(404);
  });

  it("reads a responsibility with only its sentence: no metric, no starters in its place, and a bar conversation to set one", async () => {
    const seeded = await seed();
    const [bare] = await db.insert(responsibilities).values({
      companyId: seeded.company.id, ownerUserId: OWNER, title: "Investor relations", standard: "Investors always know where we stand.", status: "active",
    }).returning();
    const detail = await request(seeded.app).get(`/api/responsibilities/${bare!.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.rollup.metric).toBeNull();
    expect(detail.body.metricName).toBeNull();
    const metrics = await request(seeded.app).get(`/api/responsibilities/${bare!.id}/metrics`);
    expect(metrics.status).toBe(200);
    // No bar metric among them: the page shows its empty state, not these.
    expect(metrics.body.metrics.some((metric: { role: string }) => metric.role === "primary")).toBe(false);
    expect((await read(seeded.app, bare!.id)).body.runs).toEqual([]);
    const started = await request(seeded.app).post(`/api/responsibilities/${bare!.id}/bar-conversation`).send({ agentId: seeded.ceo.id });
    expect(started.status).toBe(201);
    expect(started.body.state).toBe("discussing");
    expect(started.body.conversation.title).toBe("Set the bar for Investor relations");
  });
});
