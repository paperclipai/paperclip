import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { companyRoutes } from "../routes/companies.js";
import { projectRoutes } from "../routes/projects.js";
import { issueRoutes } from "../routes/issues.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company/project default execution policy tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("company/project default execution policy", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-default-execution-policy-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  type TestActor = Express.Request["actor"];

  const boardActor: TestActor = {
    type: "board",
    userId: "board-user",
    source: "local_implicit",
    isInstanceAdmin: true,
  };

  function agentActor(agentId: string, companyId: string): TestActor {
    return { type: "agent", agentId, companyId, runId: null } as TestActor;
  }

  function app(actor: TestActor) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api/companies", companyRoutes(db));
    instance.use("/api", projectRoutes(db));
    instance.use("/api", issueRoutes(db, {} as any));
    instance.use(errorHandler);
    return instance;
  }

  async function seedCompany() {
    const [company] = await db
      .insert(companies)
      .values({
        name: "Default Policy Co",
        issuePrefix: `DP${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      })
      .returning();
    return company!;
  }

  async function seedAgentRow(companyId: string) {
    const [agent] = await db
      .insert(agents)
      .values({
        companyId,
        name: "Default Policy Agent",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })
      .returning();
    return agent!;
  }

  async function seedProject(companyId: string) {
    const [project] = await db
      .insert(projects)
      .values({
        companyId,
        name: "Default Policy Project",
        status: "in_progress",
      })
      .returning();
    return project!;
  }

  const approvalPolicy = (userId: string) => ({
    mode: "normal" as const,
    commentRequired: true,
    stages: [
      {
        type: "approval" as const,
        participants: [{ type: "user" as const, userId }],
      },
    ],
  });

  it("attaches the company default execution policy when create omits one", async () => {
    const company = await seedCompany();
    await db
      .update(companies)
      .set({ defaultExecutionPolicy: approvalPolicy("company-reviewer") as never })
      .where(eq(companies.id, company.id));

    const res = await request(app(boardActor))
      .post(`/api/companies/${company.id}/issues`)
      .send({ title: "No explicit policy" })
      .expect(201);

    expect(res.body.executionPolicy).toBeTruthy();
    expect(res.body.executionPolicy.stages).toHaveLength(1);
    expect(res.body.executionPolicy.stages[0].type).toBe("approval");
    expect(res.body.executionPolicy.stages[0].participants[0]).toMatchObject({
      type: "user",
      userId: "company-reviewer",
    });
  });

  it("keeps an explicit execution policy and does not merge in the company default", async () => {
    const company = await seedCompany();
    await db
      .update(companies)
      .set({ defaultExecutionPolicy: approvalPolicy("company-reviewer") as never })
      .where(eq(companies.id, company.id));

    const res = await request(app(boardActor))
      .post(`/api/companies/${company.id}/issues`)
      .send({
        title: "Explicit policy wins",
        executionPolicy: {
          stages: [
            {
              type: "review",
              participants: [{ type: "user", userId: "explicit-reviewer" }],
            },
          ],
        },
      })
      .expect(201);

    expect(res.body.executionPolicy.stages).toHaveLength(1);
    expect(res.body.executionPolicy.stages[0].type).toBe("review");
    expect(res.body.executionPolicy.stages[0].participants[0]).toMatchObject({
      type: "user",
      userId: "explicit-reviewer",
    });
  });

  it("does not attach the default to a routine-generated issue", async () => {
    const company = await seedCompany();
    await db
      .update(companies)
      .set({ defaultExecutionPolicy: approvalPolicy("company-reviewer") as never })
      .where(eq(companies.id, company.id));

    const svc = issueService(db);
    const created = await svc.create(company.id, {
      title: "Routine-generated follow-up",
      status: "todo",
      priority: "medium",
      originKind: "routine_execution",
    });

    expect(created.executionPolicy).toBeNull();
  });

  it("does not attach the default to a conversation-thread issue", async () => {
    const company = await seedCompany();
    await db
      .update(companies)
      .set({ defaultExecutionPolicy: approvalPolicy("company-reviewer") as never })
      .where(eq(companies.id, company.id));
    const agent = await seedAgentRow(company.id);

    const svc = issueService(db);
    const created = await svc.create(company.id, {
      title: "Chat with agent",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agent.id,
      conversationAgentId: agent.id,
      conversationUserId: "chat-user-1",
      conversationState: "waiting",
    });

    expect(created.executionPolicy).toBeNull();
  });

  it("overrides the company default with the project default when both are set", async () => {
    const company = await seedCompany();
    await db
      .update(companies)
      .set({ defaultExecutionPolicy: approvalPolicy("company-reviewer") as never })
      .where(eq(companies.id, company.id));
    const project = await seedProject(company.id);
    await db
      .update(projects)
      .set({ defaultExecutionPolicy: approvalPolicy("project-reviewer") as never })
      .where(eq(projects.id, project.id));

    const res = await request(app(boardActor))
      .post(`/api/companies/${company.id}/issues`)
      .send({ title: "Scoped to project", projectId: project.id })
      .expect(201);

    expect(res.body.executionPolicy.stages[0].participants[0]).toMatchObject({
      type: "user",
      userId: "project-reviewer",
    });
  });

  it("rejects a non-board actor setting the company default execution policy", async () => {
    const company = await seedCompany();
    const agent = await seedAgentRow(company.id);

    await request(app(agentActor(agent.id, company.id)))
      .put(`/api/companies/${company.id}/default-execution-policy`)
      .send({ defaultExecutionPolicy: approvalPolicy("company-reviewer") })
      .expect(403);

    const [row] = await db.select().from(companies).where(eq(companies.id, company.id));
    expect(row!.defaultExecutionPolicy).toBeNull();
  });

  it("rejects a non-board actor setting the project default execution policy", async () => {
    const company = await seedCompany();
    const agent = await seedAgentRow(company.id);
    const project = await seedProject(company.id);

    await request(app(agentActor(agent.id, company.id)))
      .put(`/api/projects/${project.id}/default-execution-policy`)
      .send({ defaultExecutionPolicy: approvalPolicy("project-reviewer") })
      .expect(403);

    const [row] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(row!.defaultExecutionPolicy).toBeNull();
  });

  it("rejects a company default execution policy stage with no participants", async () => {
    const company = await seedCompany();

    const res = await request(app(boardActor))
      .put(`/api/companies/${company.id}/default-execution-policy`)
      .send({
        defaultExecutionPolicy: {
          stages: [{ type: "approval" }],
        },
      })
      .expect(400);

    expect(JSON.stringify(res.body)).toContain("at least one participant");
    const [row] = await db.select().from(companies).where(eq(companies.id, company.id));
    expect(row!.defaultExecutionPolicy).toBeNull();
  });

  it("rejects a project default execution policy stage with no participants", async () => {
    const company = await seedCompany();
    const project = await seedProject(company.id);

    const res = await request(app(boardActor))
      .put(`/api/projects/${project.id}/default-execution-policy`)
      .send({
        defaultExecutionPolicy: {
          stages: [{ type: "review" }],
        },
      })
      .expect(400);

    expect(JSON.stringify(res.body)).toContain("at least one participant");
    const [row] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(row!.defaultExecutionPolicy).toBeNull();
  });

  it("keeps the company default's monitor when the creator self-assigns the new task", async () => {
    const company = await seedCompany();
    const creator = await seedAgentRow(company.id);
    await db
      .update(companies)
      .set({
        defaultExecutionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [],
          monitor: { nextCheckAt: new Date(Date.now() + 60_000).toISOString() },
        } as never,
      })
      .where(eq(companies.id, company.id));

    // The creator is the assignee, so the inherited monitor is squarely
    // within what assertCanManageIssueMonitor already allows an assignee to
    // hold for its own task -- it must come through, and must not 403.
    const res = await request(app(agentActor(creator.id, company.id)))
      .post(`/api/companies/${company.id}/issues`)
      .send({
        title: "Self-assigned, picks up company default",
        assigneeAgentId: creator.id,
        status: "in_progress",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.executionPolicy.monitor).toBeTruthy();
    expect(res.body.assigneeAgentId).toBe(creator.id);
  });

  it("drops the company default's monitor, without a 422, on an ordinary create that starts in todo/backlog", async () => {
    const company = await seedCompany();
    const creator = await seedAgentRow(company.id);
    await db
      .update(companies)
      .set({
        defaultExecutionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [],
          monitor: { nextCheckAt: new Date(Date.now() + 60_000).toISOString() },
        } as never,
      })
      .where(eq(companies.id, company.id));

    // Omitting status defaults a self-assigned create to "todo", which
    // buildInitialIssueMonitorFields rejects with a 422 for any monitor
    // (inherited or explicit) regardless of who is authorized to manage it.
    // The inherited monitor must be dropped before it reaches that check,
    // not 422 an otherwise-ordinary, fully-authorized create.
    const res = await request(app(agentActor(creator.id, company.id)))
      .post(`/api/companies/${company.id}/issues`)
      .send({
        title: "Self-assigned, no status override, picks up company default",
        assigneeAgentId: creator.id,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe("todo");
    expect(res.body.executionPolicy?.monitor ?? null).toBeNull();
    expect(res.body.assigneeAgentId).toBe(creator.id);
  });

  it("drops the company default's monitor on a direct issueService.create call that bypasses the HTTP routes", async () => {
    const company = await seedCompany();
    const creator = await seedAgentRow(company.id);
    await db
      .update(companies)
      .set({
        defaultExecutionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [],
          monitor: { nextCheckAt: new Date(Date.now() + 60_000).toISOString() },
        } as never,
      })
      .where(eq(companies.id, company.id));

    // A direct service caller (e.g. inbound email creating a "todo" issue)
    // never goes through withAuthorizedInheritedMonitor the way the HTTP
    // routes do. Without the same drop applied inside create() itself, the
    // inherited monitor would reach buildInitialIssueMonitorFields and throw
    // a 422 that this caller has no HTTP response to surface -- for email,
    // that meant the delivery just retried forever. Status defaults to
    // "backlog" here (no assignee), which cannot hold a monitor either way.
    const created = await issueService(db).create(company.id, {
      title: "Created directly through the service, picks up company default",
      actorResponsibleUserId: null,
      trustExplicitResponsibleUserId: true,
    });

    expect(created.status).toBe("backlog");
    expect(
      (created.executionPolicy as { monitor?: unknown } | null)?.monitor ?? null,
    ).toBeNull();
  });

  it("drops the company default's monitor, without 403ing, when handing a task to a different assignee the creator can't manage monitors for", async () => {
    const company = await seedCompany();
    const creator = await seedAgentRow(company.id);
    const assignee = await seedAgentRow(company.id);
    await db
      .update(companies)
      .set({
        defaultExecutionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [],
          monitor: { nextCheckAt: new Date(Date.now() + 60_000).toISOString() },
        } as never,
      })
      .where(eq(companies.id, company.id));

    // The creator is neither the assignee nor privileged to manage monitors
    // on the assignee's behalf. Creating and handing off the task is still
    // allowed (the original P1 this guards against), but the inherited
    // monitor must not be silently attached -- that would let any
    // same-company agent force monitor scheduling onto another agent's task
    // purely by omitting executionPolicy, with no authorization check ever
    // running.
    const res = await request(app(agentActor(creator.id, company.id)))
      .post(`/api/companies/${company.id}/issues`)
      .send({
        title: "Handed off to another agent, picks up company default",
        assigneeAgentId: assignee.id,
        status: "in_progress",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.executionPolicy?.monitor ?? null).toBeNull();
    expect(res.body.assigneeAgentId).toBe(assignee.id);
  });

  it("drops the company default's monitor, without a 422, on a watchdog follow-up child forced to blocked for serialization", async () => {
    const company = await seedCompany();
    const creator = await seedAgentRow(company.id);
    await db
      .update(companies)
      .set({
        defaultExecutionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [],
          monitor: { nextCheckAt: new Date(Date.now() + 60_000).toISOString() },
        } as never,
      })
      .where(eq(companies.id, company.id));

    // A watchdog-parent issue with an already-running child forces any new
    // child to "blocked" (one lane at a time), regardless of what status the
    // create request asked for. The inherited-monitor check must see that
    // final "blocked" status, not the "in_progress" the request named --
    // otherwise it authorizes a monitor for a status buildInitialIssueMonitorFields
    // then 422s.
    const watchdogParent = await db
      .insert(issues)
      .values({
        companyId: company.id,
        identifier: `${company.issuePrefix}-1`,
        issueNumber: 1,
        title: "Watchdog parent",
        status: "in_progress",
        priority: "medium",
        originKind: "task_watchdog",
      })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(issues).values({
      companyId: company.id,
      identifier: `${company.issuePrefix}-2`,
      issueNumber: 2,
      title: "Currently serialized watchdog child",
      status: "in_progress",
      priority: "medium",
      parentId: watchdogParent.id,
    });

    const res = await request(app(agentActor(creator.id, company.id)))
      .post(`/api/issues/${watchdogParent.id}/children`)
      .send({
        title: "Next watchdog follow-up, picks up company default",
        assigneeAgentId: creator.id,
        status: "in_progress",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe("blocked");
    expect(res.body.executionPolicy?.monitor ?? null).toBeNull();
    expect(res.body.assigneeAgentId).toBe(creator.id);
  });

  it("still rejects an agent that explicitly sets a monitor on a task it isn't assigned", async () => {
    const company = await seedCompany();
    const agent = await seedAgentRow(company.id);

    const res = await request(app(agentActor(agent.id, company.id)))
      .post(`/api/companies/${company.id}/issues`)
      .send({
        title: "Explicit monitor without being the assignee",
        executionPolicy: {
          stages: [],
          monitor: { nextCheckAt: new Date(Date.now() + 60_000).toISOString() },
        },
      })
      .expect(403);

    expect(JSON.stringify(res.body)).toContain("manage issue monitors");
  });

  it("lets a board actor set and read back the company default execution policy", async () => {
    const company = await seedCompany();

    const put = await request(app(boardActor))
      .put(`/api/companies/${company.id}/default-execution-policy`)
      .send({ defaultExecutionPolicy: approvalPolicy("company-reviewer") })
      .expect(200);
    expect(put.body.defaultExecutionPolicy.stages[0].participants[0]).toMatchObject({
      type: "user",
      userId: "company-reviewer",
    });

    const get = await request(app(boardActor))
      .get(`/api/companies/${company.id}/default-execution-policy`)
      .expect(200);
    expect(get.body.defaultExecutionPolicy.stages[0].participants[0]).toMatchObject({
      type: "user",
      userId: "company-reviewer",
    });
  });
});
