import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  costEvents,
  createDb,
  decisions,
  feedbackVotes,
  financeEvents,
  goals,
  heartbeatRuns,
  issueComments,
  issueInboxArchives,
  issueReadStates,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { HttpError } from "../errors.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// These tests protect DELETE /api/issues/:id. A foreign key to issues.id
// without a delete policy raised SQLSTATE 23503 and the route returned a bare
// 500. The dependent rows that have meaning only with their parent issue now
// cascade. The decisions table stays restricted on purpose, so the delete must
// return a typed 409 instead of a 500.
describeEmbeddedPostgres("issueService.remove referential integrity", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-remove-cascade-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(decisions);
    await db.delete(issueThreadInteractions);
    await db.delete(issueComments);
    await db.delete(issueReadStates);
    await db.delete(issueInboxArchives);
    await db.delete(feedbackVotes);
    // finance_events references cost_events, so delete finance rows first.
    await db.delete(financeEvents);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAgentRun() {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Delete safety",
      level: "task",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Origin",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "succeeded",
    });

    return { companyId, goalId, agentId, runId };
  }

  async function seedIssue(companyId: string, goalId: string) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Deletable issue",
      status: "in_progress",
      priority: "medium",
    });
    return issueId;
  }

  it("deletes an issue and cascades its dependent rows", async () => {
    const { companyId, goalId, runId } = await seedCompanyAgentRun();
    const issueId = await seedIssue(companyId, goalId);

    await db.insert(feedbackVotes).values({
      id: randomUUID(),
      companyId,
      issueId,
      targetType: "comment",
      targetId: "target-1",
      authorUserId: "board-user",
      vote: "up",
    });
    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId,
      authorUserId: "board-user",
      body: "First comment.",
    });
    await db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId,
      issueId,
      kind: "request_confirmation",
      sourceRunId: runId,
      payload: {
        version: 1,
        prompt: "Confirm the change.",
        detailsMarkdown: "Details.",
        target: { type: "custom", key: "target", revisionId: "v1" },
      },
    });
    await db.insert(issueReadStates).values({
      id: randomUUID(),
      companyId,
      issueId,
      userId: "board-user",
    });
    await db.insert(issueInboxArchives).values({
      id: randomUUID(),
      companyId,
      issueId,
      userId: "board-user",
    });

    const removed = await svc.remove(issueId);
    expect(removed).not.toBeNull();
    expect(removed?.id).toBe(issueId);

    expect(await db.select().from(issues).where(eq(issues.id, issueId))).toHaveLength(0);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).toHaveLength(0);
    expect(
      await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId)),
    ).toHaveLength(0);
    expect(await db.select().from(issueReadStates).where(eq(issueReadStates.issueId, issueId))).toHaveLength(0);
    expect(await db.select().from(issueInboxArchives).where(eq(issueInboxArchives.issueId, issueId))).toHaveLength(0);
    expect(await db.select().from(feedbackVotes).where(eq(feedbackVotes.issueId, issueId))).toHaveLength(0);
  });

  it("deletes an issue and keeps ledger rows with issueId set to null", async () => {
    const { companyId, goalId, agentId } = await seedCompanyAgentRun();
    const issueId = await seedIssue(companyId, goalId);

    const costEventId = randomUUID();
    await db.insert(costEvents).values({
      id: costEventId,
      companyId,
      agentId,
      issueId,
      provider: "anthropic",
      model: "claude-opus-4-8",
      costCents: 100,
      occurredAt: new Date(),
    });
    const financeEventId = randomUUID();
    await db.insert(financeEvents).values({
      id: financeEventId,
      companyId,
      agentId,
      issueId,
      costEventId,
      eventKind: "usage",
      biller: "anthropic",
      amountCents: 100,
      occurredAt: new Date(),
    });

    const removed = await svc.remove(issueId);
    expect(removed?.id).toBe(issueId);

    expect(await db.select().from(issues).where(eq(issues.id, issueId))).toHaveLength(0);

    // The ledger rows must survive the delete with a detached issueId.
    const costRows = await db.select().from(costEvents).where(eq(costEvents.id, costEventId));
    expect(costRows).toHaveLength(1);
    expect(costRows[0]?.issueId).toBeNull();

    const financeRows = await db.select().from(financeEvents).where(eq(financeEvents.id, financeEventId));
    expect(financeRows).toHaveLength(1);
    expect(financeRows[0]?.issueId).toBeNull();
  });

  it("returns a 409 conflict when a restricted decisions row references the issue", async () => {
    const { companyId, goalId, agentId, runId } = await seedCompanyAgentRun();
    const issueId = await seedIssue(companyId, goalId);

    await db.insert(decisions).values({
      id: randomUUID(),
      companyId,
      originAgentId: agentId,
      originIssueId: issueId,
      originRunId: runId,
      title: "Ledger decision",
      body: "A decision that must survive issue deletion.",
      options: [],
      expiresAt: new Date(Date.now() + 60_000),
      signedSpec: "signed",
      targetSnapshots: {},
    });

    await expect(svc.remove(issueId)).rejects.toBeInstanceOf(HttpError);
    await expect(svc.remove(issueId)).rejects.toMatchObject({ status: 409 });

    // The delete failed, so the issue row must still exist.
    expect(await db.select().from(issues).where(eq(issues.id, issueId))).toHaveLength(1);
  });
});
