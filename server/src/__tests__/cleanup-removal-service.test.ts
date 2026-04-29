import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  budgetIncidents,
  budgetPolicies,
  companies,
  companySkills,
  createDb,
  documents,
  documentRevisions,
  feedbackVotes,
  heartbeatRuns,
  inboxDismissals,
  issueComments,
  issueDocuments,
  issueExecutionDecisions,
  issueInboxArchives,
  issueReadStates,
  issues,
  issueThreadInteractions,
  workspaceOperations,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { companyService } from "../services/companies.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping cleanup removal service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("cleanup removal services", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cleanup-removal-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueReadStates);
    await db.delete(issueComments);
    await db.delete(issueExecutionDecisions);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(companySkills);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
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

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Regression fixture",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      createdByUserId: "user-1",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "completed",
      contextSnapshot: { issueId },
    });

    return { agentId, companyId, issueId, runId };
  }

  it("removes agent-owned issue comments and run-linked activity before deleting the agent", async () => {
    const { agentId, companyId, issueId, runId } = await seedFixture();

    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId,
      authorAgentId: agentId,
      body: "Agent-authored comment",
    });

    await db.insert(activityLog).values({
      id: randomUUID(),
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "heartbeat.completed",
      entityType: "issue",
      entityId: issueId,
      runId,
      details: {},
    });

    await db.insert(issueExecutionDecisions).values({
      id: randomUUID(),
      companyId,
      issueId,
      stageId: randomUUID(),
      stageType: "review",
      actorAgentId: agentId,
      outcome: "approved",
      body: "Looks good",
      createdByRunId: runId,
    });

    const removed = await agentService(db).remove(agentId);

    expect(removed?.id).toBe(agentId);
    await expect(db.select().from(agents).where(eq(agents.id, agentId))).resolves.toHaveLength(0);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).resolves.toHaveLength(0);
    await expect(db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).resolves.toHaveLength(0);
    await expect(db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).resolves.toHaveLength(0);
  });

  it("removes issue read states, activity rows, budget incidents, workspace data, feedback, and thread interactions before deleting the company", async () => {
    const { companyId, issueId, runId } = await seedFixture();
    const documentId = randomUUID();
    const revisionId = randomUUID();
    const approvalId = randomUUID();
    const policyId = randomUUID();
    const incidentId = randomUUID();
    const wsOpId = randomUUID();
    const wsSvcId = randomUUID();

    await db.insert(issueReadStates).values({
      id: randomUUID(),
      companyId,
      issueId,
      userId: "user-1",
    });

    await db.insert(companySkills).values({
      id: randomUUID(),
      companyId,
      key: "paperclipai/paperclip/paperclip",
      slug: "paperclip",
      name: "Paperclip",
      markdown: "# Paperclip",
    });

    await db.insert(activityLog).values({
      id: randomUUID(),
      companyId,
      actorType: "system",
      actorId: "system",
      action: "run.created",
      entityType: "run",
      entityId: runId,
      runId,
      details: {},
    });

    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Run summary",
      latestBody: "body",
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
      createdByAgentId: null,
      createdByUserId: "user-1",
      updatedByAgentId: null,
      updatedByUserId: "user-1",
    });

    await db.insert(issueDocuments).values({
      id: randomUUID(),
      companyId,
      issueId,
      documentId,
      key: "summary",
    });

    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId,
      documentId,
      revisionNumber: 1,
      title: "Run summary",
      format: "markdown",
      body: "body",
      createdByAgentId: null,
      createdByUserId: "user-1",
      createdByRunId: runId,
    });

    // workspace_* tables
    await db.insert(workspaceOperations).values({
      id: wsOpId,
      companyId,
      phase: "build",
      status: "completed",
    });

    await db.insert(workspaceRuntimeServices).values({
      id: wsSvcId,
      companyId,
      scopeType: "issue",
      serviceName: "test-service",
      status: "running",
      lifecycle: "ephemeral",
      provider: "docker",
    });

    // inbox_dismissals
    await db.insert(inboxDismissals).values({
      id: randomUUID(),
      companyId,
      userId: "user-1",
      itemKey: `run:${runId}`,
    });

    // feedback_votes (has non-cascade FK to issues)
    await db.insert(feedbackVotes).values({
      id: randomUUID(),
      companyId,
      issueId,
      targetType: "agent_output",
      targetId: randomUUID(),
      authorUserId: "user-1",
      vote: "up",
    });

    // issue_thread_interactions (has non-cascade FK to issues)
    await db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId,
      issueId,
      kind: "review_request",
      payload: { message: "Please review" },
    });

    // issue_inbox_archives (has non-cascade FK to issues)
    await db.insert(issueInboxArchives).values({
      id: randomUUID(),
      companyId,
      issueId,
      userId: "user-1",
    });

    // budget_policies + budget_incidents (with approvalId)
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "budget_override",
      payload: { reason: "test" },
    });

    await db.insert(budgetPolicies).values({
      id: policyId,
      companyId,
      scopeType: "company",
      scopeId: companyId,
      windowKind: "monthly",
      amount: 5000,
    });

    await db.insert(budgetIncidents).values({
      id: incidentId,
      companyId,
      policyId,
      scopeType: "company",
      scopeId: companyId,
      metric: "billed_cents",
      windowKind: "monthly",
      windowStart: new Date("2026-01-01"),
      windowEnd: new Date("2026-02-01"),
      thresholdType: "hard_stop",
      amountLimit: 5000,
      amountObserved: 6000,
      approvalId,
    });

    const removed = await companyService(db).remove(companyId);

    expect(removed?.id).toBe(companyId);
    await expect(db.select().from(companies).where(eq(companies.id, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(issues).where(eq(issues.id, issueId))).resolves.toHaveLength(0);
    await expect(db.select().from(documents).where(eq(documents.id, documentId))).resolves.toHaveLength(0);
    await expect(db.select().from(documentRevisions).where(eq(documentRevisions.id, revisionId))).resolves.toHaveLength(0);
    await expect(db.select().from(issueReadStates).where(eq(issueReadStates.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).resolves.toHaveLength(0);
    // new assertions for tables added in the FK fix
    await expect(db.select().from(workspaceOperations).where(eq(workspaceOperations.id, wsOpId))).resolves.toHaveLength(0);
    await expect(db.select().from(workspaceRuntimeServices).where(eq(workspaceRuntimeServices.id, wsSvcId))).resolves.toHaveLength(0);
    await expect(db.select().from(inboxDismissals).where(eq(inboxDismissals.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(feedbackVotes).where(eq(feedbackVotes.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(issueInboxArchives).where(eq(issueInboxArchives.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(budgetIncidents).where(eq(budgetIncidents.id, incidentId))).resolves.toHaveLength(0);
    await expect(db.select().from(budgetPolicies).where(eq(budgetPolicies.id, policyId))).resolves.toHaveLength(0);
    await expect(db.select().from(approvals).where(eq(approvals.id, approvalId))).resolves.toHaveLength(0);
  });
});
