import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  companies,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { recoveryService } from "../services/recovery/service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("sweepOutOfBandDispositions", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-oob-sweep-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issueThreadInteractions);
    await db.delete(issueRecoveryActions);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedBase() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const prefix = `OB${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "OOB Co",
      issuePrefix: prefix,
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
    return { companyId, agentId, prefix };
  }

  async function seedIssue(
    companyId: string,
    prefix: string,
    num: number,
    overrides: Partial<typeof issues.$inferInsert> = {},
  ) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Issue ${num}`,
      status: "in_progress",
      priority: "medium",
      issueNumber: num,
      identifier: `${prefix}-${num}`,
      ...overrides,
    });
    return issueId;
  }

  async function seedActiveRecovery(companyId: string, sourceIssueId: string, agentId: string) {
    const svc = issueRecoveryActionService(db);
    return svc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: agentId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: `oob-test:${sourceIssueId}`,
      evidence: {},
      nextAction: "Choose a valid issue disposition.",
    });
  }

  function recovery() {
    return recoveryService(db, {
      enqueueWakeup: async () => {},
    });
  }

  it("resolves a recovery when the source issue reaches done out-of-band", async () => {
    const { companyId, agentId, prefix } = await seedBase();
    const issueId = await seedIssue(companyId, prefix, 1, { status: "in_progress", assigneeAgentId: agentId });
    const action = await seedActiveRecovery(companyId, issueId, agentId);

    // Simulate out-of-band state change: issue moves to done without going through route handler
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));

    const result = await recovery().sweepOutOfBandDispositions();

    expect(result.resolved).toBe(1);
    expect(result.issueIds).toContain(issueId);

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({ status: "cancelled", outcome: "cancelled" });
    expect(actionRow?.resolutionNote).toMatch(/reached done/);
    expect(actionRow?.resolvedAt).toBeTruthy();
  });

  it("resolves a recovery when the source issue is blocked with unresolved first-class blockers out-of-band", async () => {
    const { companyId, agentId, prefix } = await seedBase();
    const issueId = await seedIssue(companyId, prefix, 1, { status: "in_progress", assigneeAgentId: agentId });
    const blockerId = await seedIssue(companyId, prefix, 2, { status: "in_progress", assigneeAgentId: agentId });
    const action = await seedActiveRecovery(companyId, issueId, agentId);

    // Out-of-band: mark issue as blocked and add a blocker relation
    await db.update(issues).set({ status: "blocked", assigneeAgentId: null }).where(eq(issues.id, issueId));
    // blockerId blocks issueId: blockerId.type="blocks" with relatedIssueId=issueId
    await db.insert(issueRelations).values({
      id: randomUUID(),
      companyId,
      issueId: blockerId,
      relatedIssueId: issueId,
      type: "blocks",
    });

    const result = await recovery().sweepOutOfBandDispositions();

    expect(result.resolved).toBe(1);
    expect(result.issueIds).toContain(issueId);

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({ status: "cancelled", outcome: "cancelled" });
    expect(actionRow?.resolutionNote).toMatch(/unresolved first-class blockers/);
  });

  it("keeps a recovery active when the source issue is blocked with no unresolved blockers", async () => {
    const { companyId, agentId, prefix } = await seedBase();
    const issueId = await seedIssue(companyId, prefix, 1, { status: "in_progress", assigneeAgentId: agentId });
    const action = await seedActiveRecovery(companyId, issueId, agentId);

    // Out-of-band: mark issue as blocked but add no blocker relations
    await db.update(issues).set({ status: "blocked", assigneeAgentId: null }).where(eq(issues.id, issueId));

    const result = await recovery().sweepOutOfBandDispositions();

    expect(result.resolved).toBe(0);
    expect(result.skipped).toBe(1);

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow?.status).toBe("active");
  });

  it("resolves a recovery when the source issue is in_progress with an agent owner out-of-band", async () => {
    const { companyId, agentId, prefix } = await seedBase();
    // Start with no assignee (so recovery was valid), then out-of-band assign agent
    const issueId = await seedIssue(companyId, prefix, 1, { status: "in_progress", assigneeAgentId: null });
    const action = await seedActiveRecovery(companyId, issueId, agentId);

    await db.update(issues).set({ assigneeAgentId: agentId }).where(eq(issues.id, issueId));

    const result = await recovery().sweepOutOfBandDispositions();

    expect(result.resolved).toBe(1);

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({ status: "cancelled", outcome: "cancelled" });
    expect(actionRow?.resolutionNote).toMatch(/in_progress with an agent owner/);
  });

  it("resolves a recovery when the source issue gains a human owner out-of-band", async () => {
    const { companyId, agentId, prefix } = await seedBase();
    const issueId = await seedIssue(companyId, prefix, 1, { status: "in_progress", assigneeAgentId: null });
    const action = await seedActiveRecovery(companyId, issueId, agentId);

    await db.update(issues).set({ assigneeUserId: "board-user-1" }).where(eq(issues.id, issueId));

    const result = await recovery().sweepOutOfBandDispositions();

    expect(result.resolved).toBe(1);

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow?.resolutionNote).toMatch(/human owner/);
  });

  it("resolves a recovery when the source issue has a scheduled monitor out-of-band", async () => {
    const { companyId, agentId, prefix } = await seedBase();
    const issueId = await seedIssue(companyId, prefix, 1, { status: "in_review", assigneeAgentId: null });
    const action = await seedActiveRecovery(companyId, issueId, agentId);

    const futureDate = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now
    await db.update(issues).set({ monitorNextCheckAt: futureDate }).where(eq(issues.id, issueId));

    const result = await recovery().sweepOutOfBandDispositions({ now: new Date() });

    expect(result.resolved).toBe(1);

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow?.resolutionNote).toMatch(/scheduled monitor/);
  });

  it("keeps a recovery active when the source issue has no valid resting disposition", async () => {
    const { companyId, agentId, prefix } = await seedBase();
    // Issue in_review with no participant, no interactions, no approvals, no monitor
    const issueId = await seedIssue(companyId, prefix, 1, { status: "in_review", assigneeAgentId: null });
    const action = await seedActiveRecovery(companyId, issueId, agentId);

    const result = await recovery().sweepOutOfBandDispositions();

    expect(result.resolved).toBe(0);
    expect(result.skipped).toBe(1);

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow?.status).toBe("active");
  });

  it("logs activity for each resolved recovery action", async () => {
    const { companyId, agentId, prefix } = await seedBase();
    const issueId = await seedIssue(companyId, prefix, 1, { status: "done", assigneeAgentId: null });
    await seedActiveRecovery(companyId, issueId, agentId);

    await recovery().sweepOutOfBandDispositions();

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.recovery_action_resolved")));
    expect(activityRows).toHaveLength(1);
    expect(activityRows[0]?.details).toMatchObject({
      source: "out_of_band_disposition_sweep",
      outcome: "cancelled",
    });
  });

  it("handles multiple active recoveries across different issues in one sweep", async () => {
    const { companyId, agentId, prefix } = await seedBase();
    const doneIssueId = await seedIssue(companyId, prefix, 1, { status: "done" });
    const activeIssueId = await seedIssue(companyId, prefix, 2, { status: "in_progress", assigneeAgentId: null });
    const agentOwnedIssueId = await seedIssue(companyId, prefix, 3, { status: "in_progress", assigneeAgentId: agentId });

    await seedActiveRecovery(companyId, doneIssueId, agentId);
    const activeAction = await seedActiveRecovery(companyId, activeIssueId, agentId);
    await seedActiveRecovery(companyId, agentOwnedIssueId, agentId);

    const result = await recovery().sweepOutOfBandDispositions();

    expect(result.resolved).toBe(2); // done + agentOwned
    expect(result.skipped).toBe(1); // activeIssue with no valid resting disposition

    // The active one (no agent, in_progress) should still be active
    const [activeRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, activeAction.id));
    expect(activeRow?.status).toBe("active");
  });
});
