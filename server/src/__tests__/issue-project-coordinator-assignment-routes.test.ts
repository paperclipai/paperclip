import type { Db } from "@paperclipai/db";
import type { EmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import type { StorageService } from "../storage/types.js";
import type * as AdapterModule from "../adapters/index.ts";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  companies,
  companyMemberships,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Project coordinator assignment route test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof AdapterModule>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});
const mockStorageService: StorageService = {
  provider: "local_disk",
  putFile: vi.fn(async () => {
    throw new Error("Unexpected storage.putFile call");
  }),
  getObject: vi.fn(async () => {
    throw new Error("Unexpected storage.getObject call");
  }),
  headObject: vi.fn(async () => {
    throw new Error("Unexpected storage.headObject call");
  }),
  deleteObject: vi.fn(async () => {
    throw new Error("Unexpected storage.deleteObject call");
  }),
};

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres project coordinator issue-assignment route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type SeededCoordinatorProject = {
  companyId: string;
  coordinatorAgentId: string;
  projectId: string;
  workerAgentId: string;
};
let companySequence = 0;

describeEmbeddedPostgres("project coordinator issue assignment routes", () => {
  let db!: Db;
  let tempDb: EmbeddedPostgresTestDatabase | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-coordinator-issue-assignment-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(() => {
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
  });

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    runningProcesses.clear();
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", issueRoutes(db, mockStorageService));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany(name: string) {
    const companyId = randomUUID();
    companySequence += 1;
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `PC${String(companySequence).padStart(4, "0")}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(
    companyId: string,
    name: string,
    metadata: Record<string, unknown> = {},
  ) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: "test-project-coordinator" },
      runtimeConfig: {},
      permissions: {},
      metadata,
    });
    return agentId;
  }

  async function seedCoordinatorProject(): Promise<SeededCoordinatorProject> {
    const companyId = await seedCompany("Coordinator company");
    const projectId = randomUUID();
    const coordinatorAgentId = await seedAgent(companyId, "Project coordinator", {
      projectCoordinator: {
        projectId,
        templateAgentId: randomUUID(),
      },
    });
    const workerAgentId = await seedAgent(companyId, "Worker");
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Coordinator project",
      status: "in_progress",
      leadAgentId: coordinatorAgentId,
    });
    return { companyId, coordinatorAgentId, projectId, workerAgentId };
  }

  it("assigns an omitted top-level owner to the matching project coordinator while preserving backlog", async () => {
    const fixture = await seedCoordinatorProject();

    const created = await request(createApp())
      .post(`/api/companies/${fixture.companyId}/issues`)
      .send({
        projectId: fixture.projectId,
        title: "Shape the project backlog",
      })
      .expect(201);

    expect(created.body).toMatchObject({
      projectId: fixture.projectId,
      assigneeAgentId: fixture.coordinatorAgentId,
      assigneeUserId: null,
      status: "backlog",
    });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("sends coordinator-owned todo work through the native assignment wake path", async () => {
    const fixture = await seedCoordinatorProject();

    const created = await request(createApp())
      .post(`/api/companies/${fixture.companyId}/issues`)
      .send({
        projectId: fixture.projectId,
        title: "Coordinate the next delivery",
        status: "todo",
      })
      .expect(201);

    expect(created.body).toMatchObject({
      assigneeAgentId: fixture.coordinatorAgentId,
      status: "todo",
    });

    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));

    const runs = await db
      .select({ agentId: heartbeatRuns.agentId, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, fixture.coordinatorAgentId));
    expect(runs.filter((run) => run.contextSnapshot?.wakeReason === "issue_assigned")).toEqual([
      expect.objectContaining({
        agentId: fixture.coordinatorAgentId,
        contextSnapshot: expect.objectContaining({ issueId: created.body.id }),
      }),
    ]);
  });

  it("preserves explicit null, worker assignment, and human assignment", async () => {
    const fixture = await seedCoordinatorProject();
    const humanUserId = `human-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId: fixture.companyId,
      principalType: "user",
      principalId: humanUserId,
      status: "active",
      membershipRole: "member",
    });
    const app = createApp();

    const agentFieldUnassigned = await request(app)
      .post(`/api/companies/${fixture.companyId}/issues`)
      .send({
        projectId: fixture.projectId,
        title: "Leave for agent triage",
        status: "backlog",
        assigneeAgentId: null,
      })
      .expect(201);
    const userFieldUnassigned = await request(app)
      .post(`/api/companies/${fixture.companyId}/issues`)
      .send({
        projectId: fixture.projectId,
        title: "Leave for user triage",
        status: "backlog",
        assigneeUserId: null,
      })
      .expect(201);
    const workerOwned = await request(app)
      .post(`/api/companies/${fixture.companyId}/issues`)
      .send({
        projectId: fixture.projectId,
        title: "Worker-owned task",
        status: "backlog",
        assigneeAgentId: fixture.workerAgentId,
      })
      .expect(201);
    const humanOwned = await request(app)
      .post(`/api/companies/${fixture.companyId}/issues`)
      .send({
        projectId: fixture.projectId,
        title: "Human-owned task",
        status: "backlog",
        assigneeUserId: humanUserId,
      })
      .expect(201);

    expect(agentFieldUnassigned.body).toMatchObject({
      assigneeAgentId: null,
      assigneeUserId: null,
    });
    expect(userFieldUnassigned.body).toMatchObject({
      assigneeAgentId: null,
      assigneeUserId: null,
    });
    expect(workerOwned.body).toMatchObject({
      assigneeAgentId: fixture.workerAgentId,
      assigneeUserId: null,
    });
    expect(humanOwned.body).toMatchObject({
      assigneeAgentId: null,
      assigneeUserId: humanUserId,
    });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("does not adopt ordinary, mismatched, or foreign-company project leads", async () => {
    const companyId = await seedCompany("Ordinary projects");
    const foreignCompanyId = await seedCompany("Foreign coordinator company");
    const ordinaryProjectId = randomUUID();
    const mismatchedProjectId = randomUUID();
    const foreignLeadProjectId = randomUUID();
    const ordinaryLeadId = await seedAgent(companyId, "Ordinary lead");
    const mismatchedLeadId = await seedAgent(companyId, "Mismatched coordinator", {
      projectCoordinator: {
        projectId: ordinaryProjectId,
        templateAgentId: randomUUID(),
      },
    });
    const foreignLeadId = await seedAgent(foreignCompanyId, "Foreign coordinator", {
      projectCoordinator: {
        projectId: foreignLeadProjectId,
        templateAgentId: randomUUID(),
      },
    });
    await db.insert(projects).values([
      {
        id: ordinaryProjectId,
        companyId,
        name: "Ordinary project",
        leadAgentId: ordinaryLeadId,
      },
      {
        id: mismatchedProjectId,
        companyId,
        name: "Mismatched project",
        leadAgentId: mismatchedLeadId,
      },
      {
        id: foreignLeadProjectId,
        companyId,
        name: "Foreign-lead project",
        leadAgentId: foreignLeadId,
      },
    ]);
    const app = createApp();

    const ordinary = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ projectId: ordinaryProjectId, title: "Ordinary unassigned work" })
      .expect(201);
    const mismatched = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ projectId: mismatchedProjectId, title: "Mismatched unassigned work" })
      .expect(201);
    const foreignLead = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ projectId: foreignLeadProjectId, title: "Foreign lead stays unassigned" })
      .expect(201);

    expect(ordinary.body.assigneeAgentId).toBeNull();
    expect(mismatched.body.assigneeAgentId).toBeNull();
    expect(foreignLead.body.assigneeAgentId).toBeNull();
  });

  it("rejects implicit assignment when the marked coordinator is not usable", async () => {
    const fixture = await seedCoordinatorProject();
    await db
      .update(agents)
      .set({ status: "terminated" })
      .where(eq(agents.id, fixture.coordinatorAgentId));

    await request(createApp())
      .post(`/api/companies/${fixture.companyId}/issues`)
      .send({
        projectId: fixture.projectId,
        title: "Must not assign a terminated coordinator",
      })
      .expect(409);

    const companyIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.companyId, fixture.companyId));
    expect(companyIssues).toEqual([]);
  });

  it("uses the inherited parent project when defaulting a native child task", async () => {
    const fixture = await seedCoordinatorProject();
    const [parent] = await db
      .insert(issues)
      .values({
        companyId: fixture.companyId,
        projectId: fixture.projectId,
        title: "Parent task",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: fixture.workerAgentId,
      })
      .returning();

    const created = await request(createApp())
      .post(`/api/issues/${parent.id}/children`)
      .send({ title: "Coordinator-owned child", status: "backlog" })
      .expect(201);

    expect(created.body).toMatchObject({
      parentId: parent.id,
      projectId: fixture.projectId,
      assigneeAgentId: fixture.coordinatorAgentId,
      status: "backlog",
    });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });
});
