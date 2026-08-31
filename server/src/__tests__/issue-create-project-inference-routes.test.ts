import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  goals,
  heartbeatRuns,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue create project inference tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("issue create project inference", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousAgentJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;

  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "issue-create-project-inference-secret";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-create-project-inference-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(goals);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    process.env.PAPERCLIP_AGENT_JWT_SECRET = previousAgentJwtSecret;
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", issueRoutes(db, {} as never));
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
    const [agent] = await db.insert(agents).values({
      companyId,
      name: "Engineer",
      role: "engineer",
      adapterType: "process",
    }).returning();
    return agent!;
  }

  async function seedProject(
    companyId: string,
    name: string,
    workspace?: { repoUrl?: string | null; cwd?: string | null },
    goalId?: string | null,
  ) {
    const [project] = await db.insert(projects).values({
      companyId,
      name,
      status: "in_progress",
      ...(goalId ? { goalId } : {}),
    }).returning();
    if (workspace) {
      await db.insert(projectWorkspaces).values({
        companyId,
        projectId: project!.id,
        name,
        sourceType: workspace.repoUrl ? "git_repo" : "local_path",
        repoUrl: workspace.repoUrl ?? null,
        cwd: workspace.cwd ?? null,
        isPrimary: true,
      });
    }
    return project!;
  }

  /**
   * A run that is checked out on `contextIssueId`, the way the heartbeat records
   * it — no execution workspace, which is the shape that used to propagate
   * nothing.
   */
  async function seedRun(companyId: string, agentId: string, contextIssueId: string | null) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      ...(contextIssueId ? { contextSnapshot: { issueId: contextIssueId } } : {}),
    });
    return runId;
  }

  async function seedIssue(companyId: string, projectId: string | null, title = "Source task") {
    const [issue] = await db.insert(issues).values({
      companyId,
      title,
      status: "in_progress",
      priority: "medium",
      projectId,
    }).returning();
    return issue!;
  }

  function agentPost(app: express.Express, companyId: string, token: string, runId: string) {
    return request(app)
      .post(`/api/companies/${companyId}/issues`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId);
  }

  async function agentContext(companyId: string, contextProjectId: string | null) {
    const agent = await seedAgent(companyId);
    const contextIssue = await seedIssue(companyId, contextProjectId);
    const runId = await seedRun(companyId, agent.id, contextIssue.id);
    const token = createLocalAgentJwt(agent.id, companyId, agent.adapterType, runId);
    if (!token) throw new Error("expected a local agent JWT");
    return { agent, contextIssue, runId, token };
  }

  it("stamps the project of the issue the creating run is working on", async () => {
    const companyId = await seedCompany();
    const project = await seedProject(companyId, "shove", {
      repoUrl: "https://github.com/zannis/shove",
      cwd: "/repos/shove",
    });
    const { token, runId } = await agentContext(companyId, project.id);

    const created = await agentPost(createApp(), companyId, token, runId)
      .send({ title: "Follow-up: harden the retry loop" })
      .expect(201);

    expect(created.body.projectId).toBe(project.id);
  });

  it("falls back to the repo path named in the description", async () => {
    const companyId = await seedCompany();
    const actual = await seedProject(companyId, "actual", {
      repoUrl: "https://github.com/zannis/actual",
      cwd: "/paperclip/agents/repos/actual",
    });
    await seedProject(companyId, "shove", {
      repoUrl: "https://github.com/zannis/shove",
      cwd: "/paperclip/agents/repos/shove",
    });
    const { token, runId } = await agentContext(companyId, null);

    const created = await agentPost(createApp(), companyId, token, runId)
      .send({
        title: "Stranded work in the shared checkout",
        description: "Uncommitted work is sitting in /paperclip/agents/repos/actual on a local-only branch.",
      })
      .expect(201);

    expect(created.body.projectId).toBe(actual.id);
  });

  it("falls back to the repo remote named in the description", async () => {
    const companyId = await seedCompany();
    await seedProject(companyId, "actual", { repoUrl: "https://github.com/zannis/actual", cwd: "/repos/actual" });
    const shove = await seedProject(companyId, "shove", {
      repoUrl: "git@github.com:zannis/shove.git",
      cwd: "/repos/shove",
    });
    const { token, runId } = await agentContext(companyId, null);

    const created = await agentPost(createApp(), companyId, token, runId)
      .send({
        title: "Security review follow-up",
        description: "Covered by https://github.com/zannis/shove/pull/120 and its sibling.",
      })
      .expect(201);

    expect(created.body.projectId).toBe(shove.id);
  });

  it("leaves the project empty when the text names two different repos", async () => {
    const companyId = await seedCompany();
    await seedProject(companyId, "actual", { repoUrl: "https://github.com/zannis/actual", cwd: "/repos/actual" });
    await seedProject(companyId, "shove", { repoUrl: "https://github.com/zannis/shove", cwd: "/repos/shove" });
    const { token, runId } = await agentContext(companyId, null);

    const created = await agentPost(createApp(), companyId, token, runId)
      .send({
        title: "Port the fix across",
        description: "Port https://github.com/zannis/shove into /repos/actual once reviewed.",
      })
      .expect(201);

    expect(created.body.projectId).toBeNull();
  });

  it("leaves the project empty when nothing names a repo", async () => {
    const companyId = await seedCompany();
    await seedProject(companyId, "shove", { repoUrl: "https://github.com/zannis/shove", cwd: "/repos/shove" });
    const { token, runId } = await agentContext(companyId, null);

    const created = await agentPost(createApp(), companyId, token, runId)
      .send({ title: "Draft the quarterly narrative", description: "No repo is involved." })
      .expect(201);

    expect(created.body.projectId).toBeNull();
  });

  it("never overrides a project the agent named explicitly", async () => {
    const companyId = await seedCompany();
    const runProject = await seedProject(companyId, "shove", {
      repoUrl: "https://github.com/zannis/shove",
      cwd: "/repos/shove",
    });
    const chosen = await seedProject(companyId, "actual", {
      repoUrl: "https://github.com/zannis/actual",
      cwd: "/repos/actual",
    });
    const { token, runId } = await agentContext(companyId, runProject.id);

    const created = await agentPost(createApp(), companyId, token, runId)
      .send({ title: "Explicitly scoped", projectId: chosen.id })
      .expect(201);

    expect(created.body.projectId).toBe(chosen.id);
  });

  it("still prefers the parent's project over the run context", async () => {
    const companyId = await seedCompany();
    const runProject = await seedProject(companyId, "shove", { repoUrl: "https://github.com/zannis/shove", cwd: "/repos/shove" });
    const parentProject = await seedProject(companyId, "actual", { repoUrl: "https://github.com/zannis/actual", cwd: "/repos/actual" });
    const { token, runId } = await agentContext(companyId, runProject.id);
    const parent = await seedIssue(companyId, parentProject.id, "Parent task");

    const created = await agentPost(createApp(), companyId, token, runId)
      .send({ title: "Child of the parent", parentId: parent.id })
      .expect(201);

    expect(created.body.projectId).toBe(parentProject.id);
  });

  it("adopts the inferred project's default goal", async () => {
    const companyId = await seedCompany();
    const [projectGoal] = await db.insert(goals).values({
      companyId,
      title: "Ship the runtime",
      level: "company",
      status: "active",
    }).returning();
    const project = await seedProject(
      companyId,
      "shove",
      { repoUrl: "https://github.com/zannis/shove", cwd: "/repos/shove" },
      projectGoal!.id,
    );
    const { token, runId } = await agentContext(companyId, project.id);

    const created = await agentPost(createApp(), companyId, token, runId)
      .send({ title: "Follow-up work" })
      .expect(201);

    expect(created.body.projectId).toBe(project.id);
    expect(created.body.goalId).toBe(projectGoal!.id);
  });

  it("decides source trust against the inferred project, not the empty one it arrived with", async () => {
    const companyId = await seedCompany();
    const projectId = randomUUID();
    const [project] = await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "shove",
      status: "in_progress",
      // A project may carry its own authorization policy. If the project were
      // resolved after the trust decision, this task would settle inside a
      // low-trust project carrying a standard-trust stamp.
      executionWorkspacePolicy: {
        authorizationPolicy: {
          trustPreset: "low_trust_review",
          trustBoundary: { mode: "low_trust_review", companyId, projectIds: [projectId] },
        },
      },
    }).returning();
    await db.insert(projectWorkspaces).values({
      companyId,
      projectId: project!.id,
      name: "shove",
      sourceType: "git_repo",
      repoUrl: "https://github.com/zannis/shove",
      cwd: "/repos/shove",
      isPrimary: true,
    });
    const { token, runId } = await agentContext(companyId, project!.id);

    const created = await agentPost(createApp(), companyId, token, runId)
      .send({ title: "Follow-up inside a low-trust project" })
      .expect(201);

    expect(created.body.projectId).toBe(project!.id);
    expect(created.body.sourceTrust).toMatchObject({ preset: "low_trust_review" });
  });

  it("does not infer a project for a task a human created", async () => {
    const companyId = await seedCompany();
    await seedProject(companyId, "actual", {
      repoUrl: "https://github.com/zannis/actual",
      cwd: "/paperclip/agents/repos/actual",
    });

    const created = await request(createApp())
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Look at the stranded checkout",
        description: "It is in /paperclip/agents/repos/actual.",
      })
      .expect(201);

    expect(created.body.projectId).toBeNull();
  });
});
