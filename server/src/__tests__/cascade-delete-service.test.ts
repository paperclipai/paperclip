import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentApiKeys,
  agents,
  approvals,
  assets,
  budgetIncidents,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  documents,
  heartbeatRuns,
  issueAttachments,
  issueComments,
  issueDocuments,
  issueReadStates,
  issueRelations,
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
    // Additional issue-child tables to verify full cascade coverage
    // Need parent records for FK constraints
    const documentId = randomUUID();
    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Test document",
      latestBody: "# Test",
    });
    await db.insert(issueDocuments).values({
      id: randomUUID(),
      companyId,
      issueId,
      documentId,
      key: "test-key",
    });
    const assetId = randomUUID();
    await db.insert(assets).values({
      id: assetId,
      companyId,
      provider: "local",
      objectKey: "test-asset.bin",
      contentType: "application/octet-stream",
      byteSize: 1024,
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });
    await db.insert(issueAttachments).values({
      id: randomUUID(),
      companyId,
      issueId,
      assetId,
    });
    const relatedIssueId = randomUUID();
    await db.insert(issues).values({
      id: relatedIssueId,
      companyId,
      projectId,
      title: "Related issue",
      status: "open",
      priority: "low",
      issueNumber: 2,
      identifier: "PJC-2",
    });
    await db.insert(issueRelations).values({
      id: randomUUID(),
      companyId,
      issueId,
      relatedIssueId,
      type: "blocks",
    });

    const svc = projectService(db);
    await expect(svc.remove(projectId)).resolves.not.toThrow();

    const remaining = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(remaining).toHaveLength(0);
    const remainingIssues = await db.select().from(issues).where(eq(issues.projectId, projectId));
    expect(remainingIssues).toHaveLength(0);
  });

  it("agent remove() handles approval + budget incident FK without violation", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const approvalId = randomUUID();
    const budgetIncidentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Approval Cascade Co",
      issuePrefix: "APC",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Approver",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    // Create an approval requested by this agent
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "budget",
      requestedByAgentId: agentId,
      status: "approved",
      payload: { amount: 1000 },
    });
    // Create a budget policy (required FK for budget incidents)
    const policyId = randomUUID();
    await db.insert(budgetPolicies).values({
      id: policyId,
      companyId,
      scopeType: "company",
      scopeId: companyId,
      windowKind: "monthly",
    });
    // Create a budget incident linked to that approval (FK: budget_incidents.approvalId -> approvals.id)
    await db.insert(budgetIncidents).values({
      id: budgetIncidentId,
      companyId,
      policyId,
      scopeType: "agent",
      scopeId: agentId,
      metric: "cost",
      windowKind: "monthly",
      windowStart: new Date(),
      windowEnd: new Date(),
      thresholdType: "hard",
      amountLimit: 500,
      amountObserved: 750,
      status: "open",
      approvalId,
    });

    const svc = agentService(db);
    // This must not throw a FK constraint violation
    await expect(svc.remove(agentId)).resolves.not.toThrow();

    // Verify all related rows are deleted
    const remainingAgent = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(remainingAgent).toHaveLength(0);
    const remainingApproval = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(remainingApproval).toHaveLength(0);
    const remainingIncident = await db
      .select()
      .from(budgetIncidents)
      .where(eq(budgetIncidents.id, budgetIncidentId));
    expect(remainingIncident).toHaveLength(0);
  });
});
