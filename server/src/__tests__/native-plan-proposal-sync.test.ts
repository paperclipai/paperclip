import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  documentRevisions,
  documents,
  goals,
  heartbeatRuns,
  issueDocuments,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { synchronizeCompletedProviderPlan } from "../services/native-runtime/native-session-executor.js";
import { documentService } from "../services/documents.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_PLAN_PROPOSAL_TEST_DATABASE_URL");
const embeddedPostgresSupport = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const PLAN = "# Stop duplicate webhook deliveries\n\n1. Add a unique index.\n2. Upsert on the event id.";

describeEmbeddedPostgres("harness-proposed plan synchronization", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    if (!external) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plan-proposal-sync-");
    db = createDb(external ?? tempDb!.connectionString, { maxConnections: 6 });
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueThreadInteractions);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  async function seed(workMode: "standard" | "planning") {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "PPS", requireBoardApprovalForNewAgents: false });
    await db.insert(goals).values({ id: goalId, companyId, title: "Ship", level: "task", status: "active" });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Claude", role: "engineer", status: "active",
      adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(issues).values({
      id: issueId, companyId, goalId, title: "Fix duplicate deliveries", status: "in_progress",
      priority: "medium", assigneeAgentId: agentId, workMode,
    });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: { issueId } });
    const binding = { runId, issueId, companyId, agentId };
    return { companyId, issueId, agentId, runId, binding };
  }

  function proposalEvent(markdown: string, status: "streaming" | "completed" = "completed") {
    return {
      sourceEventId: `event-${randomUUID()}`,
      turnId: "turn-1",
      eventType: "plan.proposed",
      payload: {
        schema: "paperclip.plan.proposed.v1",
        proposalId: "toolu_plan",
        status,
        markdown,
        source: "claude_exit_plan_mode",
      },
    };
  }

  it("saves an agent-initiated proposal on a Standard task as the Plan document and asks for approval", async () => {
    const { issueId, binding } = await seed("standard");
    const execution = { binding, provider: { kind: "acpx" } } as never;

    const result = await synchronizeCompletedProviderPlan({ db, execution, event: proposalEvent(PLAN) });

    expect(result).toMatchObject({ status: "synchronized", planId: "toolu_plan", documentRevision: 1 });
    expect((await documentService(db).getIssueDocumentByKey(issueId, "plan"))?.body).toBe(PLAN);
    const [interaction] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId));
    expect(interaction).toMatchObject({ kind: "request_confirmation", status: "pending", sourceRunId: binding.runId });
    expect(interaction?.payload).toMatchObject({
      acceptLabel: "Approve plan",
      rejectLabel: "Request changes",
      target: { type: "issue_document", key: "plan", revisionNumber: 1 },
    });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    // The agent opted into a plan gate; the task's work mode stays Standard.
    // The run finalizer turns the pending confirmation into the review wait.
    expect(issue).toMatchObject({ status: "in_progress", workMode: "standard" });
  });

  it("revises an existing Plan document from its current revision", async () => {
    const { issueId, binding } = await seed("standard");
    await documentService(db).upsertIssueDocument({
      issueId, key: "plan", title: "Plan", format: "markdown", body: "# Old plan", createdByAgentId: binding.agentId,
    });
    const execution = { binding, provider: { kind: "acpx" } } as never;

    const result = await synchronizeCompletedProviderPlan({ db, execution, event: proposalEvent(PLAN) });

    expect(result).toMatchObject({ status: "synchronized", documentRevision: 2 });
    expect((await documentService(db).getIssueDocumentByKey(issueId, "plan"))?.body).toBe(PLAN);
  });

  it("ignores streaming proposals and Standard-mode checklists", async () => {
    const { issueId, binding } = await seed("standard");
    const execution = { binding, provider: { kind: "codex" } } as never;

    expect(await synchronizeCompletedProviderPlan({ db, execution, event: proposalEvent("# Partial", "streaming") })).toBeNull();
    expect(await synchronizeCompletedProviderPlan({
      db,
      execution,
      event: {
        sourceEventId: "checklist-1",
        eventType: "plan.updated",
        payload: { schema: "paperclip.plan.updated.v1", planId: "turn-1", revision: 1, complete: true, steps: [{ stepId: "s1", body: "Done", status: "completed" }] },
      },
    })).toBeNull();
    expect(await documentService(db).getIssueDocumentByKey(issueId, "plan")).toBeNull();
  });
});
