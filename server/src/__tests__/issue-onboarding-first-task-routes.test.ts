import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { ONBOARDING_FIRST_TASK_ORIGIN_KIND } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { runningProcesses } from "../adapters/index.ts";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

// The issue-create route dispatches an assignment wake fire-and-forget for an
// assigned agent. The wake dispatches a heartbeat run that calls the server
// adapter. Stub the adapter so the run finishes at once and does not start a
// real agent session. The stub keeps the wake path realistic and fast, so the
// afterEach drain reaches quiescence without a long real run.
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Onboarding first-task route test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres onboarding first-task route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("issue create onboarding first-task routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-onboarding-first-task-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    // Wait for the background assignment wake to reach quiescence before the
    // deletes. The wake inserts agent_wakeup_requests and heartbeat_runs rows
    // asynchronously, and a late row races the teardown deletes. The module
    // global promise sets in heartbeat.ts are shared, so a fresh heartbeatService
    // drains the route wake that this suite started.
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    // Delete heartbeat_runs and its child rows before agents and
    // agent_wakeup_requests. heartbeat_runs references both, so a completed run
    // row blocks a parent delete with a foreign-key violation.
    await db.delete(activityLog);
    await db.delete(issueThreadInteractions);
    await db.delete(issueComments);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CEO",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  function listOnboardingIssues(companyId: string) {
    return db
      .select()
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        eq(issues.originKind, ONBOARDING_FIRST_TASK_ORIGIN_KIND),
      ));
  }

  it("stamps the onboarding origin and seeds the agent-attributed greeting on the first task", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const app = createApp();

    const created = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Get started", onboardingFirstTask: true, assigneeAgentId: agentId })
      .expect(201);

    expect(created.body.originKind).toBe(ONBOARDING_FIRST_TASK_ORIGIN_KIND);
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, created.body.id));
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ authorType: "agent", authorAgentId: agentId });
  });

  it("seeds the two-option opening question card as the assignee on the first task", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const app = createApp();

    const created = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Get started", onboardingFirstTask: true, assigneeAgentId: agentId })
      .expect(201);

    const interactions = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.issueId, created.body.id));
    expect(interactions).toHaveLength(1);
    expect(interactions[0]).toMatchObject({
      kind: "ask_user_questions",
      status: "pending",
      createdByAgentId: agentId,
      createdByUserId: null,
      continuationPolicy: "wake_assignee",
    });
    const payload = interactions[0].payload as {
      supersedeOnUserComment?: boolean;
      questions: Array<{ selectionMode: string; options: Array<{ id: string; label: string; freeText?: boolean }> }>;
    };
    expect(payload.supersedeOnUserComment).toBe(true);
    expect(payload.questions).toHaveLength(1);
    expect(payload.questions[0].selectionMode).toBe("single");
    expect(payload.questions[0].options.map((option) => option.id)).toEqual(["interview", "task"]);
    expect(payload.questions[0].options[0].label).toBe(
      "Interview me and propose a plan and an agent team to execute it.",
    );
    expect(payload.questions[0].options[1]).toMatchObject({ label: "I have a task in mind", freeText: true });

    // The seeded card is read-only for the thread until the user answers: it
    // must not have queued a run by itself.
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("does not seed the opening card on an unassigned onboarding first task", async () => {
    const companyId = await seedCompany();
    const app = createApp();

    const created = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Get started", onboardingFirstTask: true })
      .expect(201);

    const interactions = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.issueId, created.body.id));
    expect(interactions).toHaveLength(0);
  });

  it("fails closed to an ordinary issue when the onboarding origin is already claimed", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const app = createApp();
    // Simulate the losing side of the count-vs-create race: the winning issue
    // already claimed the onboarding origin but is hidden, so the zero-count
    // fast path still passes and only issues_onboarding_first_task_uq rejects
    // the privileged insert.
    await db.insert(issues).values({
      companyId,
      title: "Race winner",
      status: "todo",
      priority: "medium",
      originKind: ONBOARDING_FIRST_TASK_ORIGIN_KIND,
      hiddenAt: new Date(),
    });

    const created = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Race loser", onboardingFirstTask: true, assigneeAgentId: agentId })
      .expect(201);

    expect(created.body.originKind).toBe("manual");
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, created.body.id));
    expect(comments).toHaveLength(0);
    expect(await listOnboardingIssues(companyId)).toHaveLength(1);
  });

  it("allows at most one onboarding first task across concurrent creates", async () => {
    const companyId = await seedCompany();
    const app = createApp();

    const responses = await Promise.all(
      ["Kick off A", "Kick off B", "Kick off C"].map((title) =>
        request(app)
          .post(`/api/companies/${companyId}/issues`)
          .send({ title, onboardingFirstTask: true }),
      ),
    );

    for (const response of responses) expect(response.status).toBe(201);
    expect(await listOnboardingIssues(companyId)).toHaveLength(1);
  });

  it("stores the server-assembled brief as the description and ignores the client description", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const app = createApp();

    const created = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Get started",
        description: "client supplied description that must be ignored",
        onboardingFirstTask: true,
        assigneeAgentId: agentId,
      })
      .expect(201);

    expect(created.body.description).toContain("This is the user's first task in Paperclip.");
    expect(created.body.description).toContain("Take the path the user picked.");
    // Toggle defaults off → the confirmation proposal form is inlined.
    expect(created.body.description).toContain("post ONE request_confirmation that says, in a few lines");
    expect(created.body.description).not.toContain("treat it like the plan path");
    expect(created.body.description).not.toContain("client supplied description");
  });

  it("uses the plan proposal brief when enableFirstTaskPlanProposal is on", async () => {
    const companyId = await seedCompany();
    const app = createApp();
    await db
      .insert(instanceSettings)
      .values({ singletonKey: "default", general: {}, experimental: { enableFirstTaskPlanProposal: true } })
      .onConflictDoUpdate({
        target: [instanceSettings.singletonKey],
        set: { experimental: { enableFirstTaskPlanProposal: true } },
      });

    const created = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Get started", onboardingFirstTask: true })
      .expect(201);

    expect(created.body.description).toContain("This is the user's first task in Paperclip.");
    expect(created.body.description).toContain("treat it like the plan path");
    expect(created.body.description).not.toContain("post ONE request_confirmation that says, in a few lines");

    await db.delete(instanceSettings);
  });

  it("does not queue an assignment wake for the onboarding first task", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const app = createApp();

    await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Get started", onboardingFirstTask: true, assigneeAgentId: agentId })
      .expect(201);

    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));
    expect(wakeups).toHaveLength(0);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("still queues an assignment wake for an ordinary assigned issue", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const app = createApp();

    await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Ordinary task", assigneeAgentId: agentId })
      .expect(201);

    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));
    // An ordinary assigned create still queues the assignment wake for the agent.
    expect(wakeups.length).toBeGreaterThan(0);
    expect(wakeups.some((row) => row.agentId === agentId)).toBe(true);
  });
});
