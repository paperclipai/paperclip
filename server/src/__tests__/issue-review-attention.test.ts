import { reconcileReviewDependencyHolds } from "../services/review-dependency-hold.js";
import { eq } from "drizzle-orm";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
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
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres review attention tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue review attention", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-review-attention-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issueRecoveryActions);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(activityLog);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Review Attention Co",
      issuePrefix: "RVA",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Review Agent",
      role: "engineer",
      status: "idle",
    });
    return { companyId, agentId };
  }

  async function insertReview(input: {
    companyId: string;
    agentId: string;
    identifier: string;
    assigneeUserId?: string | null;
    executionState?: Record<string, unknown> | null;
    monitorNextCheckAt?: Date | null;
    executionPolicy?: Record<string, unknown> | null;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      identifier: input.identifier,
      title: input.identifier,
      status: "in_review",
      priority: "medium",
      assigneeAgentId: input.assigneeUserId ? null : input.agentId,
      assigneeUserId: input.assigneeUserId ?? null,
      executionState: input.executionState ?? null,
      monitorNextCheckAt: input.monitorNextCheckAt ?? null,
      executionPolicy: input.executionPolicy ?? null,
    });
    return id;
  }

  it.each(["in_review", "in_progress"])("records approval while awaiting blockers from %s and completes after the last blocker resolves", async (status) => {
    const { companyId, agentId } = await seed();
    const stageId = randomUUID();
    const participant = { type: "agent" as const, agentId, userId: null };
    const policy = normalizeIssueExecutionPolicy({ mode: "normal", stages: [
      { id: stageId, type: "review", participants: [participant] },
    ] });
    const issueId = await insertReview({ companyId, agentId, identifier: "RVA-101", executionPolicy: policy,
      executionState: { status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review",
        currentParticipant: participant, returnAssignee: null, reviewRequest: null, completedStageIds: [],
        lastDecisionId: null, lastDecisionOutcome: null } });
    await db.update(issues).set({ status }).where(eq(issues.id, issueId));
    const blockerIds = [randomUUID(), randomUUID()];
    await db.insert(issues).values(blockerIds.map((id, index) => ({ id, companyId, title: `Prerequisite ${index}`,
      identifier: `RVA-${102 + index}`, status: "backlog" })));
    await db.insert(issueRelations).values(blockerIds.map((id) => ({ companyId, issueId: id,
      relatedIssueId: issueId, type: "blocks" })));
    const issue = (await db.select().from(issues).where(eq(issues.id, issueId)))[0];
    const transition = applyIssueExecutionPolicyTransition({ issue, policy, requestedStatus: "done",
      actor: { agentId, userId: null }, requestedAssigneePatch: {}, allowBoardOverride: false, commentBody: "Approved after review" });
    expect(transition.decision?.outcome).toBe("approved");
    const held = await svc.update(issueId, { status: "done", ...transition.patch });
    expect(held?.status).toBe(status);
    expect(held?.completedAt).toBeNull();
    expect(held?.executionState).toMatchObject({ status: "completed", completedStageIds: [stageId],
      dependencyHold: { unresolvedBlockerIssueIds: expect.arrayContaining(blockerIds) } });
    const attention = (await svc.listReviewAttention(companyId, [{ id: issueId, companyId, status: "in_review" }])).get(issueId);
    expect(attention).toMatchObject({ state: "covered" });
    expect(attention?.reason).toContain("RVA-102");
    expect(attention?.reason).toContain("RVA-103");
    await svc.update(blockerIds[0], { status: "done" });
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].status).toBe(status);
    await svc.update(blockerIds[1], { status: "done" });
    const completed = (await db.select().from(issues).where(eq(issues.id, issueId)))[0];
    expect(completed.status).toBe("done");
    expect(completed.executionState).toMatchObject({ status: "completed", dependencyHold: null });
  });

  async function seedApprovedHold(companyId: string, agentId: string, blockerId: string, index: number) {
    const stageId = randomUUID();
    return insertReview({ companyId, agentId, identifier: `RVA-${200 + index}`,
      executionPolicy: normalizeIssueExecutionPolicy({ stages: [{ id: stageId, type: "review",
        participants: [{ type: "agent", agentId }] }] }),
      executionState: { status: "completed", currentStageId: null, currentStageIndex: null,
        currentStageType: null, currentParticipant: null, returnAssignee: null,
        completedStageIds: [stageId], lastDecisionId: randomUUID(), lastDecisionOutcome: "approved",
        dependencyHold: { heldAt: new Date().toISOString(), unresolvedBlockerIssueIds: [blockerId] } },
    });
  }

  it.each(["active", "resolved"])("preserves a %s execution reconciliation hold after blockers resolve", async (status) => {
    const { companyId, agentId } = await seed();
    const blockerId = await insertReview({ companyId, agentId, identifier: "RVA-199" });
    const issueId = await seedApprovedHold(companyId, agentId, blockerId, 0);
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: issueId, type: "blocks" });
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId,
      kind: "execution_reconciliation", cause: "legacy_execution_requires_reconciliation", status,
      fingerprint: randomUUID(), nextAction: "Reconcile the stopped execution",
      evidence: status === "resolved" ? { automaticRecovery: { replay: "blocked" } } : {},
    });
    await svc.update(blockerId, { status: "done" });
    expect((await svc.getById(issueId))?.status).toBe("in_review");
    await db.delete(issueRecoveryActions);
    expect(await reconcileReviewDependencyHolds(db, { companyId, blockerIssueId: blockerId })).toEqual([issueId]);
    expect((await svc.getById(issueId))?.status).toBe("done");
  });

  it("reconciles all 101 approved dependents in a targeted pass", async () => {
    const { companyId, agentId } = await seed();
    const blockerId = await insertReview({ companyId, agentId, identifier: "RVA-199" });
    const ids: string[] = [];
    for (let index = 0; index < 101; index++) ids.push(await seedApprovedHold(companyId, agentId, blockerId, index));
    await db.insert(issueRelations).values(ids.map((id) => ({ companyId, issueId: blockerId, relatedIssueId: id, type: "blocks" })));
    // Directly settle the prerequisite so this assertion observes exactly one targeted pass.
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockerId));
    expect(await reconcileReviewDependencyHolds(db, { companyId, blockerIssueId: blockerId })).toHaveLength(101);
    expect((await db.select().from(issues)).filter((row) => ids.includes(row.id) && row.status === "done")).toHaveLength(101);
  });

  it("preflights proposed blocker sets without editing stored relations", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await insertReview({ companyId, agentId, identifier: "RVA-400" });
    const blockerId = await insertReview({ companyId, agentId, identifier: "RVA-401" });
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, blockerId));
    expect(await svc.getDependencyReadiness(issueId, db, [blockerId])).toMatchObject({
      isDependencyReady: false, unresolvedBlockerIssueIds: [blockerId],
    });
    expect(await svc.getDependencyReadiness(issueId)).toMatchObject({ isDependencyReady: true });
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: issueId, type: "blocks" });
    expect(await svc.getDependencyReadiness(issueId, db, [])).toMatchObject({ isDependencyReady: true });
    expect(await svc.getDependencyReadiness(issueId)).toMatchObject({ isDependencyReady: false });
  });

  it.each(["missing", "cross-company", "self", "cycle"])("rejects %s proposed blockers during approval preflight", async (kind) => {
    const { companyId, agentId } = await seed();
    const issueId = await insertReview({ companyId, agentId, identifier: "RVA-410" });
    let blockerId = randomUUID();
    if (kind === "cross-company") {
      const otherCompanyId = randomUUID();
      await db.insert(companies).values({ id: otherCompanyId, name: "Other company", issuePrefix: "OTHER" });
      await db.insert(issues).values({ id: blockerId, companyId: otherCompanyId, title: "Private blocker", status: "done" });
    } else if (kind === "self") {
      blockerId = issueId;
    } else if (kind === "cycle") {
      await db.insert(issues).values({ id: blockerId, companyId, title: "Dependent", status: "done" });
      await db.insert(issueRelations).values({ companyId, issueId, relatedIssueId: blockerId, type: "blocks" });
    }
    const before = await svc.getById(issueId);
    await expect(svc.getDependencyReadiness(issueId, db, [blockerId])).rejects.toThrow(
      kind === "self" ? "Issue cannot be blocked by itself"
        : kind === "cycle" ? "Blocking relations cannot contain cycles"
        : "Blocked-by issues must belong to the same company",
    );
    expect(await svc.getById(issueId)).toEqual(before);
    expect(await svc.getDependencyReadiness(issueId)).toMatchObject({ isDependencyReady: true });
  });

  it("accepts duplicate valid proposed blockers without mutating relations", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await insertReview({ companyId, agentId, identifier: "RVA-420" });
    const blockerId = randomUUID();
    await db.insert(issues).values({ id: blockerId, companyId, title: "Complete", status: "done" });
    expect(await svc.getDependencyReadiness(issueId, db, [blockerId, blockerId])).toMatchObject({
      isDependencyReady: true, blockerIssueIds: [blockerId],
    });
    expect(await svc.getDependencyReadiness(issueId)).toMatchObject({ blockerIssueIds: [] });
  });

  it("refuses a builder completing an issue with unresolved blockers", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await insertReview({ companyId, agentId, identifier: "RVA-104" });
    const blockerId = randomUUID();
    await db.insert(issues).values({ id: blockerId, companyId, title: "Unfinished prerequisite", status: "todo" });
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: issueId, type: "blocks" });
    await expect(svc.update(issueId, { status: "done" })).rejects.toThrow("Issue is blocked by unresolved blockers");
  });

  it("surfaces a pathless agent-owned review as stalled and a queued recovery as covered", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await insertReview({ companyId, agentId, identifier: "RVA-1" });

    let row = (await svc.list(companyId, { status: "in_review" })).find((issue) => issue.id === issueId);
    expect(row?.reviewAttention).toMatchObject({
      state: "stalled",
      paths: [],
    });
    expect(row?.reviewAttention?.reason).toContain("no participant, interaction, approval");

    const recoveryIdempotencyKey = `issue_review_path_lost:${issueId}:fingerprint`;
    const recoveryWake = {
      companyId,
      agentId,
      source: "automation",
      reason: "issue_review_path_lost",
      status: "queued",
      payload: { issueId },
      idempotencyKey: recoveryIdempotencyKey,
    };
    await db.insert(agentWakeupRequests).values(recoveryWake);
    await expect(db.insert(agentWakeupRequests).values(recoveryWake)).rejects.toMatchObject({
      cause: {
        code: "23505",
        constraint_name: "agent_wakeup_requests_review_path_recovery_idempotency_uq",
      },
    });

    row = (await svc.list(companyId, { status: "in_review" })).find((issue) => issue.id === issueId);
    expect(row?.reviewAttention).toMatchObject({
      state: "covered",
      paths: [expect.objectContaining({ kind: "queued_wake", responder: "Review Agent" })],
    });
  });

  it("reports every healthy review path as covered", async () => {
    const { companyId, agentId } = await seed();
    const interactionIssueId = await insertReview({ companyId, agentId, identifier: "RVA-2" });
    const humanOnlyInteractionIssueId = await insertReview({ companyId, agentId, identifier: "RVA-2H" });
    const approvalIssueId = await insertReview({ companyId, agentId, identifier: "RVA-3" });
    const monitorIssueId = await insertReview({
      companyId,
      agentId,
      identifier: "RVA-4",
      monitorNextCheckAt: new Date(Date.now() + 60_000),
      executionPolicy: { monitor: { maxAttempts: 3 } },
    });
    const humanIssueId = await insertReview({
      companyId,
      agentId,
      identifier: "RVA-5",
      assigneeUserId: "board-user",
    });
    const participantIssueId = await insertReview({
      companyId,
      agentId,
      identifier: "RVA-6",
      executionState: { status: "pending", currentParticipant: { type: "agent", agentId } },
    });
    const activeRunIssueId = await insertReview({ companyId, agentId, identifier: "RVA-7" });
    const recoveryIssueId = await insertReview({ companyId, agentId, identifier: "RVA-8" });

    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId: interactionIssueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      payload: { version: 1, prompt: "Approve?" },
    });
    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId: humanOnlyInteractionIssueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      requestedResolverPolicy: "human_only",
      effectiveResolverPolicy: "human_only",
      resolverPolicyProvenance: "explicit",
      effectiveResolverPolicySource: "requested",
      payload: { version: 1, prompt: "Human review?" },
    });
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      status: "pending",
      payload: { title: "Review" },
    });
    await db.insert(issueApprovals).values({ companyId, issueId: approvalIssueId, approvalId });
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId: activeRunIssueId },
    });
    await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: recoveryIssueId,
      kind: "missing_disposition",
      status: "active",
      ownerType: "agent",
      ownerAgentId: agentId,
      cause: "review_path_lost",
      fingerprint: "review-path",
      evidence: {},
      nextAction: "Restore review path",
    });

    const rows = await svc.list(companyId, { status: "in_review" });
    const byId = new Map(rows.map((row) => [row.id, row.reviewAttention]));
    const expectedKinds = new Map([
      [interactionIssueId, "interaction"],
      [humanOnlyInteractionIssueId, "interaction"],
      [approvalIssueId, "approval"],
      [monitorIssueId, "monitor"],
      [humanIssueId, "human_reviewer"],
      [participantIssueId, "execution_participant"],
      [activeRunIssueId, "active_run"],
      [recoveryIssueId, "recovery"],
    ]);

    for (const [issueId, kind] of expectedKinds) {
      expect(byId.get(issueId), kind).toMatchObject({
        state: "covered",
        paths: expect.arrayContaining([expect.objectContaining({ kind })]),
      });
    }
    expect(byId.get(interactionIssueId)?.paths).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "interaction", responder: "Review Agent" }),
    ]));
    expect(byId.get(humanOnlyInteractionIssueId)?.paths).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "interaction", responder: "Board" }),
    ]));
  });

  it("does not let a transiently skipped recovery consume its fingerprint", async () => {
    const { companyId, agentId } = await seed();
    const idempotencyKey = `issue_review_path_lost:${randomUUID()}:fingerprint`;
    const baseWake = {
      companyId,
      agentId,
      source: "automation",
      reason: "issue_review_path_lost",
      payload: {},
      idempotencyKey,
    };

    await db.insert(agentWakeupRequests).values({
      ...baseWake,
      status: "skipped",
      finishedAt: new Date(),
    });

    await expect(db.insert(agentWakeupRequests).values({
      ...baseWake,
      status: "queued",
    })).resolves.toBeDefined();
  });
});
