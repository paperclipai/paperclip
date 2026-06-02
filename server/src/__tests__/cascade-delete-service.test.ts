import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentApiKeys,
  agents,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  issueComments,
  issueReadStates,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyService } from "../services/companies.js";
import { agentService } from "../services/agents.js";
import { projectService } from "../services/projects.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping cascade-delete tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("cascade-delete service handlers (GH#7250)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cascade-delete-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("company remove() cascades all child rows without FK violation", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Cascade Test Co",
      issuePrefix: "CAS",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worker",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Do something",
      status: "open",
      priority: "medium",
      issueNumber: 1,
      identifier: "CAS-1",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "succeeded",
      invocationSource: "assignment",
    });
    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId,
      body: "A comment",
      authorAgentId: agentId,
    });

    const svc = companyService(db);
    await expect(svc.remove(companyId)).resolves.not.toThrow();

    const remaining = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(remaining).toHaveLength(0);
  });

  it("agent remove() cascades agent-scoped child rows without FK violation", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Agent Cascade Co",
      issuePrefix: "AGC",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Write tests",
      status: "open",
      priority: "medium",
      issueNumber: 1,
      identifier: "AGC-1",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "succeeded",
      invocationSource: "assignment",
    });
    await db.insert(agentApiKeys).values({
      id: randomUUID(),
      companyId,
      agentId,
      name: "test key",
      keyHash: "deadbeef01",
    });
    await db.insert(costEvents).values({
      id: randomUUID(),
      companyId,
      agentId,
      provider: "anthropic",
      biller: "server",
      billingType: "llm",
      model: "claude-sonnet-4-6",
      inputTokens: 100,
      outputTokens: 50,
      costCents: 1,
      occurredAt: new Date(),
    });

    const svc = agentService(db);
    await expect(svc.remove(agentId)).resolves.not.toThrow();

    const remaining = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(remaining).toHaveLength(0);
  });

  it("project remove() cascades project issues and their children without FK violation", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Project Cascade Co",
      issuePrefix: "PJC",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Dev",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "My Project",
      color: "blue",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Project task",
      status: "open",
      priority: "medium",
      issueNumber: 1,
      identifier: "PJC-1",
    });
    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId,
      body: "Comment on project issue",
      authorAgentId: agentId,
    });
    await db.insert(issueReadStates).values({
      id: randomUUID(),
      issueId,
      companyId,
      userId: randomUUID(),
    });
    await db.insert(costEvents).values({
      id: randomUUID(),
      companyId,
      agentId,
      projectId,
      provider: "anthropic",
      biller: "server",
      billingType: "llm",
      model: "claude-sonnet-4-6",
      inputTokens: 10,
      outputTokens: 5,
      costCents: 0,
      occurredAt: new Date(),
    });

    const svc = projectService(db);
    await expect(svc.remove(projectId)).resolves.not.toThrow();

    const remaining = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(remaining).toHaveLength(0);
    const remainingIssues = await db.select().from(issues).where(eq(issues.projectId, projectId));
    expect(remainingIssues).toHaveLength(0);
  });
});
