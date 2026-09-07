import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  executionWorkspaces,
  goals,
  heartbeatRuns,
  instanceSettings,
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
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";

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
    await db.delete(instanceSettings);
    await db.delete(executionWorkspaces);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(goals);
    await db.delete(companyMemberships);
    await db.delete(authUsers);
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

  it("infers for the child of a project-less parent instead of chaining its emptiness", async () => {
    const companyId = await seedCompany();
    const actual = await seedProject(companyId, "actual", {
      repoUrl: "https://github.com/zannis/actual",
      cwd: "/repos/actual",
    });
    const { token, runId } = await agentContext(companyId, null);
    const parent = await seedIssue(companyId, null, "Project-less root");

    const created = await agentPost(createApp(), companyId, token, runId)
      .send({
        title: "Harden the retry loop",
        parentId: parent.id,
        description: "The flake lives in https://github.com/zannis/actual and blocks the release.",
      })
      .expect(201);

    expect(created.body.projectId).toBe(actual.id);
  });

  it("treats an explicit inheritance source as the one source signal, without falling through to the parent's project", async () => {
    const companyId = await seedCompany();
    const parentProject = await seedProject(companyId, "shove", {
      repoUrl: "https://github.com/zannis/shove",
      cwd: "/repos/shove",
    });
    const actual = await seedProject(companyId, "actual", {
      repoUrl: "https://github.com/zannis/actual",
      cwd: "/repos/actual",
    });
    // The two issue-bearing fields form one signal: the inheritance source
    // outranks the parent, and a project-less source resolves the signal to
    // nothing — the parent's project must not leak back in through the gate,
    // so inference runs instead.
    const sourceIssue = await seedIssue(companyId, null, "Project-less source");
    const parent = await seedIssue(companyId, parentProject.id, "Parent with a project");
    const { token, runId } = await agentContext(companyId, null);

    const created = await agentPost(createApp(), companyId, token, runId)
      .send({
        title: "Chase the regression",
        parentId: parent.id,
        inheritExecutionWorkspaceFromIssueId: sourceIssue.id,
        description: "Bisect it inside https://github.com/zannis/actual.",
      })
      .expect(201);

    expect(created.body.projectId).toBe(actual.id);
  });

  it("keeps the parent's project when the explicit parent suppresses the run-inheritance source", async () => {
    const companyId = await seedCompany();
    const parentProject = await seedProject(companyId, "shove", {
      repoUrl: "https://github.com/zannis/shove",
      cwd: "/repos/shove",
    });
    await seedProject(companyId, "actual", {
      repoUrl: "https://github.com/zannis/actual",
      cwd: "/repos/actual",
    });
    const agent = await seedAgent(companyId);
    // An explicit parentId is a workspace selection, so the route never injects
    // the run's own issue as an inheritance source; the parent is the one
    // source signal, it resolves, and inference is never consulted — even
    // though the run works a project-less issue and the text names another repo.
    const sourceIssue = await seedIssue(companyId, null, "Project-less source");
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: agent.id,
      status: "running",
      contextSnapshot: { issueId: sourceIssue.id, executionWorkspaceId: randomUUID() },
    });
    const token = createLocalAgentJwt(agent.id, companyId, agent.adapterType, runId);
    if (!token) throw new Error("expected a local agent JWT");
    const parent = await seedIssue(companyId, parentProject.id, "Parent with a project");

    const created = await agentPost(createApp(), companyId, token, runId)
      .send({
        title: "Chase the regression",
        parentId: parent.id,
        description: "Bisect it inside https://github.com/zannis/actual.",
      })
      .expect(201);

    expect(created.body.projectId).toBe(parentProject.id);
  });

  it("never consults inference when a selected workspace resolves to a project", async () => {
    const companyId = await seedCompany();
    const chosen = await seedProject(companyId, "actual", {
      repoUrl: "https://github.com/zannis/actual",
      cwd: "/repos/actual",
    });
    await seedProject(companyId, "shove", { repoUrl: "https://github.com/zannis/shove", cwd: "/repos/shove" });
    const workspace = await db
      .select({ id: projectWorkspaces.id })
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.projectId, chosen.id))
      .then((rows) => rows[0]!);
    const { token, runId } = await agentContext(companyId, null);

    const created = await agentPost(createApp(), companyId, token, runId)
      .send({
        title: "Scoped by workspace",
        description: "The text talks about https://github.com/zannis/shove but the workspace decides.",
        projectWorkspaceId: workspace.id,
      })
      .expect(201);

    expect(created.body.projectId).toBe(chosen.id);
  });

  /**
   * A source issue that carries a workspace but no project of its own. No
   * create or update path writes that row today — every one of them derives the
   * project from the workspace whenever the project is absent — so it only
   * arrives with imported or hand-repaired data. The gate must not depend on
   * that invariant holding: `issueService.create` forwards this source's
   * workspace into the child and derives the child's project from it, so the
   * signal resolves and a repo named in the child's text must not outrank it.
   */
  async function seedWorkspaceOnlySourceIssue(companyId: string, projectId: string, title: string) {
    const workspace = await db
      .select({ id: projectWorkspaces.id })
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.projectId, projectId))
      .then((rows) => rows[0]!);
    const issue = await seedIssue(companyId, null, title);
    await db.update(issues).set({ projectWorkspaceId: workspace.id }).where(eq(issues.id, issue.id));
    return issue;
  }

  it("resolves a project-less parent through the workspace the child inherits from it", async () => {
    const companyId = await seedCompany();
    const linked = await seedProject(companyId, "shove", {
      repoUrl: "https://github.com/zannis/shove",
      cwd: "/repos/shove",
    });
    await seedProject(companyId, "actual", { repoUrl: "https://github.com/zannis/actual", cwd: "/repos/actual" });
    const parent = await seedWorkspaceOnlySourceIssue(companyId, linked.id, "Imported project-less root");
    const { token, runId } = await agentContext(companyId, null);

    const created = await agentPost(createApp(), companyId, token, runId)
      .send({
        title: "Harden the retry loop",
        parentId: parent.id,
        description: "The flake lives in https://github.com/zannis/actual and blocks the release.",
      })
      .expect(201);

    expect(created.body.projectId).toBe(linked.id);
  });

  it("resolves a project-less parent through its workspace on the children route too", async () => {
    const companyId = await seedCompany();
    const linked = await seedProject(companyId, "shove", {
      repoUrl: "https://github.com/zannis/shove",
      cwd: "/repos/shove",
    });
    await seedProject(companyId, "actual", { repoUrl: "https://github.com/zannis/actual", cwd: "/repos/actual" });
    const parent = await seedWorkspaceOnlySourceIssue(companyId, linked.id, "Imported project-less root");
    const { token, runId } = await agentContext(companyId, null);

    const created = await request(createApp())
      .post(`/api/issues/${parent.id}/children`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({
        title: "Split out the repro",
        description: "Reproduce it under https://github.com/zannis/actual first.",
      })
      .expect(201);

    expect(created.body.projectId).toBe(linked.id);
  });

  it("keeps a workspace named on the request ahead of the one the parent lends", async () => {
    const companyId = await seedCompany();
    const lent = await seedProject(companyId, "shove", {
      repoUrl: "https://github.com/zannis/shove",
      cwd: "/repos/shove",
    });
    const chosen = await seedProject(companyId, "actual", {
      repoUrl: "https://github.com/zannis/actual",
      cwd: "/repos/actual",
    });
    const parent = await seedWorkspaceOnlySourceIssue(companyId, lent.id, "Imported project-less root");
    const chosenWorkspace = await db
      .select({ id: projectWorkspaces.id })
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.projectId, chosen.id))
      .then((rows) => rows[0]!);
    const { token, runId } = await agentContext(companyId, null);

    // The service only fills an empty workspace slot from the source, so the
    // workspace on the request is the one it derives the project from.
    const created = await agentPost(createApp(), companyId, token, runId)
      .send({
        title: "Scoped by its own workspace",
        parentId: parent.id,
        projectWorkspaceId: chosenWorkspace.id,
      })
      .expect(201);

    expect(created.body.projectId).toBe(chosen.id);
  });

  it("still forwards the workspace a project-less parent lends, not the project's default", async () => {
    const companyId = await seedCompany();
    const linked = await seedProject(companyId, "shove", {
      repoUrl: "https://github.com/zannis/shove",
      cwd: "/repos/shove",
    });
    // A second, non-primary workspace in the same project: the one the parent
    // lends. The project's default resolves to the primary one, so inheriting
    // and defaulting are distinguishable here — with a single-workspace project
    // both answers coincide and the drop is invisible.
    const [lent] = await db.insert(projectWorkspaces).values({
      companyId,
      projectId: linked.id,
      name: "shove-docs",
      sourceType: "git_repo",
      repoUrl: "https://github.com/zannis/shove",
      cwd: "/repos/shove-docs",
      isPrimary: false,
    }).returning();
    const parent = await seedIssue(companyId, null, "Imported project-less root");
    await db.update(issues).set({ projectWorkspaceId: lent!.id }).where(eq(issues.id, parent.id));
    const { token, runId } = await agentContext(companyId, null);

    const created = await agentPost(createApp(), companyId, token, runId)
      .send({ title: "Harden the retry loop", parentId: parent.id })
      .expect(201);

    // Pinning the project the parent's workspace resolves to must not cost the
    // child that workspace: the service compares the pinned project against the
    // project the source lends, so the linkage still crosses.
    expect(created.body.projectId).toBe(linked.id);
    expect(created.body.projectWorkspaceId).toBe(lent!.id);
  });

  it("infers for a child created via the children route when the parent is project-less", async () => {
    const companyId = await seedCompany();
    const actual = await seedProject(companyId, "actual", {
      repoUrl: "https://github.com/zannis/actual",
      cwd: "/repos/actual",
    });
    const { token, runId } = await agentContext(companyId, null);
    const parent = await seedIssue(companyId, null, "Project-less root");

    const created = await request(createApp())
      .post(`/api/issues/${parent.id}/children`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({
        title: "Split out the repro",
        description: "Reproduce it under /repos/actual first.",
      })
      .expect(201);

    expect(created.body.projectId).toBe(actual.id);
  });

  it("keeps the parent's project on the children route without consulting inference", async () => {
    const companyId = await seedCompany();
    const parentProject = await seedProject(companyId, "shove", {
      repoUrl: "https://github.com/zannis/shove",
      cwd: "/repos/shove",
    });
    await seedProject(companyId, "actual", { repoUrl: "https://github.com/zannis/actual", cwd: "/repos/actual" });
    const { token, runId } = await agentContext(companyId, null);
    const parent = await seedIssue(companyId, parentProject.id, "Parent with a project");

    const created = await request(createApp())
      .post(`/api/issues/${parent.id}/children`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({
        title: "Child under a scoped parent",
        description: "Even though the text names https://github.com/zannis/actual.",
      })
      .expect(201);

    expect(created.body.projectId).toBe(parentProject.id);
  });

  it("still infers when the selected execution workspace is a signal the service will discard", async () => {
    const companyId = await seedCompany();
    const actual = await seedProject(companyId, "actual", {
      repoUrl: "https://github.com/zannis/actual",
      cwd: "/repos/actual",
    });
    const shove = await seedProject(companyId, "shove", { repoUrl: "https://github.com/zannis/shove", cwd: "/repos/shove" });
    // Isolated workspaces are off (the default), so `issueService.create`
    // deletes `executionWorkspaceId` before deriving anything from it. The
    // workspace's project must therefore not suppress inference: the signal is
    // present but yields nothing.
    const [workspace] = await db.insert(executionWorkspaces).values({
      companyId,
      projectId: shove.id,
      mode: "worktree",
      strategyType: "worktree",
      name: "shove worktree",
    }).returning();
    const { token, runId } = await agentContext(companyId, null);

    const created = await agentPost(createApp(), companyId, token, runId)
      .send({
        title: "Harden the retry loop",
        description: "The flake lives in https://github.com/zannis/actual and blocks the release.",
        executionWorkspaceId: workspace!.id,
      })
      .expect(201);

    expect(created.body.projectId).toBe(actual.id);
  });

  it("decides source trust against the project the parent resolves to", async () => {
    const companyId = await seedCompany();
    const projectId = randomUUID();
    const [project] = await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "shove",
      status: "in_progress",
      executionWorkspacePolicy: {
        authorizationPolicy: {
          trustPreset: "low_trust_review",
          trustBoundary: { mode: "low_trust_review", companyId, projectIds: [projectId] },
        },
      },
    }).returning();
    const { token, runId } = await agentContext(companyId, null);
    const parent = await seedIssue(companyId, project!.id, "Parent inside the low-trust project");

    // No explicit `projectId` on the body: the project arrives through the
    // parent. Trust must be decided against that project, not the empty field.
    const created = await agentPost(createApp(), companyId, token, runId)
      .send({ title: "Child of a low-trust parent", parentId: parent.id })
      .expect(201);

    expect(created.body.projectId).toBe(project!.id);
    expect(created.body.sourceTrust).toMatchObject({ preset: "low_trust_review" });
  });

  it("decides source trust against the workspace-selected project", async () => {
    const companyId = await seedCompany();
    const projectId = randomUUID();
    const [project] = await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "shove",
      status: "in_progress",
      executionWorkspacePolicy: {
        authorizationPolicy: {
          trustPreset: "low_trust_review",
          trustBoundary: { mode: "low_trust_review", companyId, projectIds: [projectId] },
        },
      },
    }).returning();
    const [workspace] = await db.insert(projectWorkspaces).values({
      companyId,
      projectId: project!.id,
      name: "shove",
      sourceType: "git_repo",
      repoUrl: "https://github.com/zannis/shove",
      cwd: "/repos/shove",
      isPrimary: true,
    }).returning();
    const { token, runId } = await agentContext(companyId, null);

    const created = await agentPost(createApp(), companyId, token, runId)
      .send({ title: "Scoped by workspace", projectWorkspaceId: workspace!.id })
      .expect(201);

    expect(created.body.projectId).toBe(project!.id);
    expect(created.body.sourceTrust).toMatchObject({ preset: "low_trust_review" });
  });

  it("infers at the service layer for agent children created without the HTTP route", async () => {
    // Accepted-plan decomposition, the runner's create_task tool and accepted
    // suggested tasks all call `issueService.createChild` directly — the
    // backstop in `create` has to catch a project-less parent there too.
    const companyId = await seedCompany();
    const actual = await seedProject(companyId, "actual", {
      repoUrl: "https://github.com/zannis/actual",
      cwd: "/repos/actual",
    });
    const agent = await seedAgent(companyId);
    const parent = await seedIssue(companyId, null, "Project-less root");

    const { issue } = await issueService(db).createChild(parent.id, {
      title: "Split out the repro",
      description: "Reproduce it in https://github.com/zannis/actual first.",
      status: "todo",
      priority: "medium",
      createdByAgentId: agent.id,
    });

    expect(issue.projectId).toBe(actual.id);
  });

  it("quarantines a service-layer inference into a low-trust project", async () => {
    // Direct callers never ran the route's source-trust decision, so when the
    // backstop stamps a project that carries a low-trust policy, the same
    // verdict has to ride along — otherwise the tool path launders a write the
    // HTTP path would have quarantined.
    const companyId = await seedCompany();
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "shove",
      status: "in_progress",
      executionWorkspacePolicy: {
        authorizationPolicy: {
          trustPreset: "low_trust_review",
          trustBoundary: { mode: "low_trust_review", companyId, projectIds: [projectId] },
        },
      },
    });
    await db.insert(projectWorkspaces).values({
      companyId,
      projectId,
      name: "shove",
      sourceType: "git_repo",
      repoUrl: "https://github.com/zannis/shove",
      cwd: "/repos/shove",
      isPrimary: true,
    });
    const agent = await seedAgent(companyId);
    const parent = await seedIssue(companyId, null, "Project-less root");

    const { issue } = await issueService(db).createChild(parent.id, {
      title: "Split out the repro",
      description: "Reproduce it in https://github.com/zannis/shove first.",
      status: "todo",
      priority: "medium",
      createdByAgentId: agent.id,
    });

    expect(issue.projectId).toBe(projectId);
    expect(issue.sourceTrust).toMatchObject({
      preset: "low_trust_review",
      disposition: "quarantined",
    });
  });

  it("withdraws a service-layer inference when the trust policy fails closed", async () => {
    // An invalid project policy resolves to a denial. The route fails such a
    // create outright; the backstop's project was only a guess, so it
    // withdraws the guess instead — the task lands project-less, never inside
    // a project whose policy could not be evaluated.
    const companyId = await seedCompany();
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "shove",
      status: "in_progress",
      executionWorkspacePolicy: {
        authorizationPolicy: { trustPreset: "not-a-real-preset" },
      },
    });
    await db.insert(projectWorkspaces).values({
      companyId,
      projectId,
      name: "shove",
      sourceType: "git_repo",
      repoUrl: "https://github.com/zannis/shove",
      cwd: "/repos/shove",
      isPrimary: true,
    });
    const agent = await seedAgent(companyId);
    const parent = await seedIssue(companyId, null, "Project-less root");

    const { issue } = await issueService(db).createChild(parent.id, {
      title: "Split out the repro",
      description: "Reproduce it in https://github.com/zannis/shove first.",
      status: "todo",
      priority: "medium",
      createdByAgentId: agent.id,
    });

    expect(issue.projectId).toBeNull();
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

  async function seedAssignmentProtectedProject(companyId: string) {
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "shove",
      status: "in_progress",
      executionWorkspacePolicy: {
        authorizationPolicy: {
          assignmentPolicy: { mode: "protected" },
        },
      },
    });
    await db.insert(projectWorkspaces).values({
      companyId,
      projectId,
      name: "shove",
      sourceType: "git_repo",
      repoUrl: "https://github.com/zannis/shove",
      cwd: "/repos/shove",
      isPrimary: true,
    });
    return projectId;
  }

  it("withdraws a service-layer inference when the actor may not assign into the inferred project", async () => {
    // The HTTP route gates an *assigned* create behind tasks:assign against
    // the project the issue lands in. A direct caller (plan decomposition,
    // the runner's create_task tool) never ran that gate, so the backstop has
    // to run it before attaching its guess — a protected project without an
    // assignment grant stays out of reach, and the guess is withdrawn.
    const companyId = await seedCompany();
    await seedAssignmentProtectedProject(companyId);
    const creator = await seedAgent(companyId);
    const assignee = await seedAgent(companyId);
    const parent = await seedIssue(companyId, null, "Project-less root");

    const { issue } = await issueService(db).createChild(parent.id, {
      title: "Split out the repro",
      description: "Reproduce it in https://github.com/zannis/shove first.",
      status: "todo",
      priority: "medium",
      createdByAgentId: creator.id,
      assigneeAgentId: assignee.id,
    });

    expect(issue.projectId).toBeNull();
    expect(issue.assigneeAgentId).toBe(assignee.id);
  });

  it("keeps the inferred project when the actor may assign into it", async () => {
    // Same shape, but an assignment policy that stays company-default: the
    // assignment check must not over-withdraw a project the route would have
    // allowed.
    const companyId = await seedCompany();
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "shove",
      status: "in_progress",
      executionWorkspacePolicy: {
        authorizationPolicy: {
          assignmentPolicy: { mode: "company_default" },
        },
      },
    });
    await db.insert(projectWorkspaces).values({
      companyId,
      projectId,
      name: "shove",
      sourceType: "git_repo",
      repoUrl: "https://github.com/zannis/shove",
      cwd: "/repos/shove",
      isPrimary: true,
    });
    const creator = await seedAgent(companyId);
    const assignee = await seedAgent(companyId);
    const parent = await seedIssue(companyId, null, "Project-less root");

    const { issue } = await issueService(db).createChild(parent.id, {
      title: "Split out the repro",
      description: "Reproduce it in https://github.com/zannis/shove first.",
      status: "todo",
      priority: "medium",
      createdByAgentId: creator.id,
      assigneeAgentId: assignee.id,
    });

    expect(issue.projectId).toBe(projectId);
    expect(issue.assigneeAgentId).toBe(assignee.id);
  });

  async function seedResponsibleUser(companyId: string, membershipRole: "operator" | "viewer") {
    const userId = `resp-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({
      id: userId,
      name: "Responsible",
      email: `${userId}@example.test`,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole,
    });
    return userId;
  }

  it("withdraws a service-layer inference when the run's responsible user cannot authorize the assignment", async () => {
    // Route parity again, one layer deeper: an authenticated agent actor
    // always carries the run's responsible user, and tasks:assign intersects
    // with that user's own authorization — an unavailable responsible user
    // denies the route create outright. The backstop's reconstructed actor
    // has to carry the same context or that layer silently never runs.
    const companyId = await seedCompany();
    await seedProject(companyId, "shove", {
      repoUrl: "https://github.com/zannis/shove",
      cwd: "/repos/shove",
    });
    const creator = await seedAgent(companyId);
    const assignee = await seedAgent(companyId);
    const parent = await seedIssue(companyId, null, "Project-less root");
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: creator.id,
      status: "running",
      responsibleUserId: `missing-${randomUUID()}`,
    });

    const { issue } = await issueService(db).createChild(parent.id, {
      title: "Split out the repro",
      description: "Reproduce it in https://github.com/zannis/shove first.",
      status: "todo",
      priority: "medium",
      createdByAgentId: creator.id,
      assigneeAgentId: assignee.id,
      actorRunId: runId,
    });

    expect(issue.projectId).toBeNull();
    expect(issue.assigneeAgentId).toBe(assignee.id);
  });

  it("withdraws a service-layer inference when the caller's explicit responsible user cannot authorize it", async () => {
    // Same intersection through the other actor-level source: a caller that
    // names the responsible user directly instead of leaving it on the run.
    const companyId = await seedCompany();
    await seedProject(companyId, "shove", {
      repoUrl: "https://github.com/zannis/shove",
      cwd: "/repos/shove",
    });
    const creator = await seedAgent(companyId);
    const assignee = await seedAgent(companyId);
    const parent = await seedIssue(companyId, null, "Project-less root");

    const { issue } = await issueService(db).createChild(parent.id, {
      title: "Split out the repro",
      description: "Reproduce it in https://github.com/zannis/shove first.",
      status: "todo",
      priority: "medium",
      createdByAgentId: creator.id,
      assigneeAgentId: assignee.id,
      actorResponsibleUserId: `missing-${randomUUID()}`,
    });

    expect(issue.projectId).toBeNull();
    expect(issue.assigneeAgentId).toBe(assignee.id);
  });

  it("keeps the inferred project when the run's responsible user is authorized", async () => {
    // The intersection must not over-withdraw: a responsible user with an
    // active assignment-granting membership authorizes the same create the
    // route would have allowed.
    const companyId = await seedCompany();
    const project = await seedProject(companyId, "shove", {
      repoUrl: "https://github.com/zannis/shove",
      cwd: "/repos/shove",
    });
    const creator = await seedAgent(companyId);
    const assignee = await seedAgent(companyId);
    const parent = await seedIssue(companyId, null, "Project-less root");
    const responsibleUserId = await seedResponsibleUser(companyId, "operator");
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: creator.id,
      status: "running",
      responsibleUserId,
    });

    const { issue } = await issueService(db).createChild(parent.id, {
      title: "Split out the repro",
      description: "Reproduce it in https://github.com/zannis/shove first.",
      status: "todo",
      priority: "medium",
      createdByAgentId: creator.id,
      assigneeAgentId: assignee.id,
      actorRunId: runId,
    });

    expect(issue.projectId).toBe(project.id);
    expect(issue.assigneeAgentId).toBe(assignee.id);
  });

  it("withdraws a service-layer inference when the caller's key scope cannot assign", async () => {
    // The backstop must authorize the caller, not a reconstruction of it: a
    // skill-test-scoped key is flatly denied tasks:assign at the routes, and
    // handing the backstop an actor without that key scope would attach a
    // project the caller's own key could never have assigned into.
    const companyId = await seedCompany();
    await seedProject(companyId, "shove", {
      repoUrl: "https://github.com/zannis/shove",
      cwd: "/repos/shove",
    });
    const creator = await seedAgent(companyId);
    const assignee = await seedAgent(companyId);
    const parent = await seedIssue(companyId, null, "Project-less root");
    const responsibleUserId = await seedResponsibleUser(companyId, "operator");

    const { issue } = await issueService(db).createChild(parent.id, {
      title: "Split out the repro",
      description: "Reproduce it in https://github.com/zannis/shove first.",
      status: "todo",
      priority: "medium",
      createdByAgentId: creator.id,
      assigneeAgentId: assignee.id,
      actorAuthorization: {
        type: "agent",
        agentId: creator.id,
        companyId,
        source: "agent_key",
        keyScope: { kind: "skill_test", issueId: randomUUID() },
        onBehalfOfUserId: responsibleUserId,
      },
    });

    expect(issue.projectId).toBeNull();
    expect(issue.assigneeAgentId).toBe(assignee.id);
  });

  it("authorizes the caller's acting agent, not the created-by agent", async () => {
    // When the caller's actor names a different acting agent than the one the
    // issue is attributed to, the decision belongs to the actor — an acting
    // agent outside the company withdraws the inference even though the
    // created-by agent alone would have been allowed.
    const companyId = await seedCompany();
    await seedProject(companyId, "shove", {
      repoUrl: "https://github.com/zannis/shove",
      cwd: "/repos/shove",
    });
    const creator = await seedAgent(companyId);
    const assignee = await seedAgent(companyId);
    const parent = await seedIssue(companyId, null, "Project-less root");

    const { issue } = await issueService(db).createChild(parent.id, {
      title: "Split out the repro",
      description: "Reproduce it in https://github.com/zannis/shove first.",
      status: "todo",
      priority: "medium",
      createdByAgentId: creator.id,
      assigneeAgentId: assignee.id,
      actorAuthorization: {
        type: "agent",
        agentId: randomUUID(),
        companyId,
        source: "agent_key",
      },
    });

    expect(issue.projectId).toBeNull();
    expect(issue.assigneeAgentId).toBe(assignee.id);
  });

  it("keeps the inferred project for an unscoped caller actor", async () => {
    // The caller-actor path must not over-withdraw: a full-scope agent-key
    // actor authorizes the same attachment the route would have allowed.
    const companyId = await seedCompany();
    const project = await seedProject(companyId, "shove", {
      repoUrl: "https://github.com/zannis/shove",
      cwd: "/repos/shove",
    });
    const creator = await seedAgent(companyId);
    const assignee = await seedAgent(companyId);
    const parent = await seedIssue(companyId, null, "Project-less root");
    const responsibleUserId = await seedResponsibleUser(companyId, "operator");

    const { issue } = await issueService(db).createChild(parent.id, {
      title: "Split out the repro",
      description: "Reproduce it in https://github.com/zannis/shove first.",
      status: "todo",
      priority: "medium",
      createdByAgentId: creator.id,
      assigneeAgentId: assignee.id,
      actorAuthorization: {
        type: "agent",
        agentId: creator.id,
        companyId,
        source: "agent_key",
        onBehalfOfUserId: responsibleUserId,
      },
    });

    expect(issue.projectId).toBe(project.id);
    expect(issue.assigneeAgentId).toBe(assignee.id);
  });

  it("still infers into an assignment-protected project when the create is unassigned", async () => {
    // Route parity: tasks:assign only gates creates that carry an assignee.
    // An unassigned create lands in the protected project the same way the
    // HTTP route would have allowed it to.
    const companyId = await seedCompany();
    const projectId = await seedAssignmentProtectedProject(companyId);
    const creator = await seedAgent(companyId);
    const parent = await seedIssue(companyId, null, "Project-less root");

    const { issue } = await issueService(db).createChild(parent.id, {
      title: "Split out the repro",
      description: "Reproduce it in https://github.com/zannis/shove first.",
      status: "todo",
      priority: "medium",
      createdByAgentId: creator.id,
    });

    expect(issue.projectId).toBe(projectId);
  });

  /**
   * A parent as the routes see it after a concurrent move: project-less when
   * the route resolved and authorized the create, holding `projectId` (and its
   * workspace) by the time the insert transaction reads it.
   */
  async function seedParentThatGainedAProject(companyId: string, projectId: string) {
    const workspace = await db
      .select({ id: projectWorkspaces.id })
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.projectId, projectId))
      .then((rows) => rows[0]!);
    const [parent] = await db.insert(issues).values({
      companyId,
      title: "Parent that just gained a project",
      status: "in_progress",
      priority: "medium",
      projectId,
      projectWorkspaceId: workspace.id,
    }).returning();
    return parent!;
  }

  it("aborts a pinned null resolution when the parent gained a project after the route decided", async () => {
    // The route decided assignment scope and source trust against a
    // project-less parent, so the pin must not re-derive that parent's new
    // project inside the transaction — nothing on this request evaluated it.
    // But persisting the stale null would let a snapshot outrank a parent
    // signal that now resolves, which is the guarantee this whole change
    // rests on. The create aborts retryably instead; the retry re-resolves
    // and re-authorizes against the project the parent now holds.
    const companyId = await seedCompany();
    const project = await seedProject(companyId, "actual", {
      repoUrl: "https://github.com/zannis/actual",
      cwd: "/repos/actual",
    });
    const parent = await seedParentThatGainedAProject(companyId, project.id);

    await expect(issueService(db).create(companyId, {
      title: "Child created against a null resolution",
      status: "todo",
      priority: "medium",
      parentId: parent.id,
      projectId: null,
      pinProjectId: true,
      pinnedProjectResolvedFromSource: true,
    })).rejects.toThrow(/changed concurrently/);
  });

  it("aborts an inferred pin when the parent gained a project after the route decided", async () => {
    const companyId = await seedCompany();
    const parentProject = await seedProject(companyId, "actual", {
      repoUrl: "https://github.com/zannis/actual",
      cwd: "/repos/actual",
    });
    const inferred = await seedProject(companyId, "shove", {
      repoUrl: "https://github.com/zannis/shove",
      cwd: "/repos/shove",
    });
    const creator = await seedAgent(companyId);
    const parent = await seedParentThatGainedAProject(companyId, parentProject.id);

    await expect(issueService(db).create(companyId, {
      title: "Child the route guessed a project for",
      description: "Reproduce it in https://github.com/zannis/shove first.",
      status: "todo",
      priority: "medium",
      parentId: parent.id,
      createdByAgentId: creator.id,
      projectId: inferred.id,
      pinProjectId: true,
      pinnedProjectResolvedFromSource: true,
    })).rejects.toThrow(/changed concurrently/);
  });

  it("aborts a pinned resolution the parent outgrew even when the child skips workspace inheritance", async () => {
    // A `strategy_only` child never reads its parent for workspace linkage, so
    // the staleness check cannot ride along on that read — the parent is still
    // the source the route pinned against.
    const companyId = await seedCompany();
    const project = await seedProject(companyId, "actual", {
      repoUrl: "https://github.com/zannis/actual",
      cwd: "/repos/actual",
    });
    const parent = await seedParentThatGainedAProject(companyId, project.id);

    await expect(issueService(db).create(companyId, {
      title: "Strategy-only child",
      status: "todo",
      priority: "medium",
      parentId: parent.id,
      projectId: null,
      pinProjectId: true,
      pinnedProjectResolvedFromSource: true,
      skipExecutionWorkspaceInheritance: true,
    })).rejects.toThrow(/changed concurrently/);
  });

  it("keeps a pinned resolution the parent still lends", async () => {
    // The ordinary resolving-parent create: the pin agrees with what the
    // parent lends, so nothing moved and the workspace linkage still crosses.
    const companyId = await seedCompany();
    const project = await seedProject(companyId, "actual", {
      repoUrl: "https://github.com/zannis/actual",
      cwd: "/repos/actual",
    });
    const parent = await seedParentThatGainedAProject(companyId, project.id);

    const issue = await issueService(db).create(companyId, {
      title: "Child of a parent that never moved",
      status: "todo",
      priority: "medium",
      parentId: parent.id,
      projectId: project.id,
      pinProjectId: true,
      pinnedProjectResolvedFromSource: true,
    });

    expect(issue.projectId).toBe(project.id);
    expect(issue.projectWorkspaceId).toBe(parent.projectWorkspaceId);
  });

  it("keeps an inferred pin when the parent still lends nothing", async () => {
    // The case the whole change exists for: a source that resolves to none is
    // not a disagreement, so inference's answer stands.
    const companyId = await seedCompany();
    const inferred = await seedProject(companyId, "shove", {
      repoUrl: "https://github.com/zannis/shove",
      cwd: "/repos/shove",
    });
    const creator = await seedAgent(companyId);
    const parent = await seedIssue(companyId, null, "Project-less parent");

    const issue = await issueService(db).create(companyId, {
      title: "Child of a project-less parent",
      description: "Reproduce it in https://github.com/zannis/shove first.",
      status: "todo",
      priority: "medium",
      parentId: parent.id,
      createdByAgentId: creator.id,
      projectId: inferred.id,
      pinProjectId: true,
      pinnedProjectResolvedFromSource: true,
    });

    expect(issue.projectId).toBe(inferred.id);
  });

  it("keeps a cross-project child whose project the request named itself", async () => {
    // A request carrying its own `projectId` never read the parent, so a
    // parent in another project is a deliberate cross-project create rather
    // than a stale answer — the routes leave the premise flag off for it.
    const companyId = await seedCompany();
    const parentProject = await seedProject(companyId, "actual", {
      repoUrl: "https://github.com/zannis/actual",
      cwd: "/repos/actual",
    });
    const chosen = await seedProject(companyId, "shove", {
      repoUrl: "https://github.com/zannis/shove",
      cwd: "/repos/shove",
    });
    const parent = await seedParentThatGainedAProject(companyId, parentProject.id);

    const issue = await issueService(db).create(companyId, {
      title: "Child that targets another project",
      status: "todo",
      priority: "medium",
      parentId: parent.id,
      projectId: chosen.id,
      pinProjectId: true,
      pinnedProjectResolvedFromSource: false,
    });

    expect(issue.projectId).toBe(chosen.id);
  });

  it("does not read a project out of an execution workspace the request suppressed", async () => {
    // The parent lends its project only through an execution workspace, and
    // the request names an execution-workspace field — which keeps that
    // linkage out entirely. A source lends no project through a slot it never
    // forwards, so the gate answered null, inference supplied the project, and
    // the two still agree.
    const companyId = await seedCompany();
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    const workspaceProject = await seedProject(companyId, "actual", {
      repoUrl: "https://github.com/zannis/actual",
      cwd: "/repos/actual",
    });
    const inferred = await seedProject(companyId, "shove", {
      repoUrl: "https://github.com/zannis/shove",
      cwd: "/repos/shove",
    });
    const creator = await seedAgent(companyId);
    const parent = await seedIssue(companyId, null, "Project-less parent");
    const [executionWorkspace] = await db.insert(executionWorkspaces).values({
      companyId,
      projectId: workspaceProject.id,
      mode: "worktree",
      strategyType: "worktree",
      name: "actual worktree",
    }).returning();
    await db.update(issues)
      .set({ executionWorkspaceId: executionWorkspace!.id })
      .where(eq(issues.id, parent.id));

    const issue = await issueService(db).create(companyId, {
      title: "Child that wants its own workspace",
      description: "Reproduce it in https://github.com/zannis/shove first.",
      status: "todo",
      priority: "medium",
      parentId: parent.id,
      createdByAgentId: creator.id,
      projectId: inferred.id,
      pinProjectId: true,
      pinnedProjectResolvedFromSource: true,
      executionWorkspacePreference: "new_workspace",
    });

    expect(issue.projectId).toBe(inferred.id);
  });

  it("pinProjectId stops createChild from re-deriving the parent's project", async () => {
    const companyId = await seedCompany();
    const project = await seedProject(companyId, "actual", {
      repoUrl: "https://github.com/zannis/actual",
      cwd: "/repos/actual",
    });
    const parent = await seedIssue(companyId, project.id, "Parent inside a project");

    const { issue } = await issueService(db).createChild(parent.id, {
      title: "Pinned project-less child",
      status: "todo",
      priority: "medium",
      projectId: null,
      pinProjectId: true,
    });

    expect(issue.projectId).toBeNull();
  });

  it("pinProjectId suppresses the service-layer inference backstop", async () => {
    // A route that pins null already ran the same inference and decided its
    // authorization questions against the null answer. The backstop re-running
    // inference inside the transaction would reintroduce exactly the unpinned
    // window the flag exists to close.
    const companyId = await seedCompany();
    await seedProject(companyId, "shove", {
      repoUrl: "https://github.com/zannis/shove",
      cwd: "/repos/shove",
    });
    const creator = await seedAgent(companyId);

    const issue = await issueService(db).create(companyId, {
      title: "Pinned in spite of a matching description",
      description: "Reproduce it in https://github.com/zannis/shove first.",
      status: "todo",
      priority: "medium",
      createdByAgentId: creator.id,
      projectId: null,
      pinProjectId: true,
    });

    expect(issue.projectId).toBeNull();
  });
});
