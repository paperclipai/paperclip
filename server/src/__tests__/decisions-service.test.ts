import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  decisionEffectExecutions,
  decisions,
  decisionTargetIssues,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { attentionService } from "../services/attention.js";
import { decisionService } from "../services/decisions.js";

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

describePg("decisionService", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;
  let originIssueId: string;
  let targetIssueId: string;
  let runId: string;
  let originResponsibleUserId: string;
  let decidedByUserId: string;
  let wakes: Array<Record<string, unknown>>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-decisions-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    process.env.PAPERCLIP_DECISION_SIGNING_SECRET = "0123456789abcdef0123456789abcdef";
    companyId = randomUUID(); agentId = randomUUID(); originIssueId = randomUUID(); targetIssueId = randomUUID(); runId = randomUUID();
    originResponsibleUserId = `origin-${randomUUID()}`; decidedByUserId = `decider-${randomUUID()}`; wakes = [];
    const now = new Date();
    await db.insert(companies).values({ id: companyId, name: "Decisions", issuePrefix: `D${companyId.slice(0, 6)}`, requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values([
      { id: originResponsibleUserId, name: "Origin", email: `${originResponsibleUserId}@example.test`, createdAt: now, updatedAt: now },
      { id: decidedByUserId, name: "Decider", email: `${decidedByUserId}@example.test`, createdAt: now, updatedAt: now },
    ]);
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: originResponsibleUserId, status: "active", membershipRole: "member" },
      { companyId, principalType: "user", principalId: decidedByUserId, status: "active", membershipRole: "member" },
    ]);
    await db.insert(agents).values({ id: agentId, companyId, name: "Proposer", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values([
      { id: originIssueId, companyId, title: "Origin", status: "in_progress", priority: "medium", assigneeAgentId: agentId, responsibleUserId: originResponsibleUserId },
      { id: targetIssueId, companyId, title: "Target", status: "todo", priority: "medium", responsibleUserId: decidedByUserId },
    ]);
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", responsibleUserId: originResponsibleUserId, contextSnapshot: { issueId: originIssueId } });
  });

  afterEach(async () => {
    delete process.env.PAPERCLIP_DECISIONS_SWEEP_BATCH_SIZE;
    await db.delete(decisionEffectExecutions); await db.delete(decisionTargetIssues); await db.delete(decisions); await db.delete(activityLog);
    await db.delete(issueComments); await db.delete(heartbeatRuns); await db.delete(issues); await db.delete(agents); await db.delete(companyMemberships); await db.delete(authUsers); await db.delete(companies);
  });
  afterAll(async () => tempDb?.cleanup());

  const agentActor = () => ({ type: "agent" as const, companyId, agentId, runId, source: "agent_jwt" as const,
    onBehalfOfUserId: originResponsibleUserId, onBehalfOfMemberships: [{ companyId, membershipRole: "member", status: "active" }] });
  const boardActor = () => ({ type: "board" as const, userId: decidedByUserId, companyIds: [companyId], source: "session" as const,
    memberships: [{ companyId, membershipRole: "member", status: "active" }] });
  const service = () => decisionService(db, { wakeOriginAgent: async (input) => { wakes.push(input); } });
  const createCommentDecision = (staleness: "strict" | "lenient" = "lenient", extra: Record<string, unknown> = {}) => service().create({
    companyId, actor: agentActor(), agentId, runId, title: "Comment?", body: "Body", continuationPolicy: "wake_origin_agent",
    options: [{ id: "yes", label: "Yes", effects: [{ type: "comment_on_issue", targetIssueId, staleness, bodyMarkdown: "hello" }] }],
    ...extra,
  });

  it("returns the existing decision for concurrent idempotent creates", async () => {
    const input = {
      companyId, actor: agentActor(), agentId, runId, title: "Same?", body: "Body", idempotencyKey: "concurrent-create",
      options: [{ id: "yes", label: "Yes", effects: [{ type: "comment_on_issue" as const, targetIssueId, staleness: "lenient" as const, bodyMarkdown: "hello" }] }],
    };
    const [first, second] = await Promise.all([service().create(input), service().create(input)]);
    expect(second.id).toBe(first.id);
    expect(await db.select().from(decisions).where(eq(decisions.idempotencyKey, "concurrent-create"))).toHaveLength(1);
  });

  it("executes once, replays stored outcome, and attributes executor audit to the decider", async () => {
    const created = await createCommentDecision();
    const first = await service().decide({ id: created.id, optionId: "yes", idempotencyKey: "decide-1", decidedByUserId, userActor: boardActor() });
    const replay = await service().decide({ id: created.id, optionId: "yes", idempotencyKey: "decide-1", decidedByUserId, userActor: boardActor() });
    expect(first.executionStatus).toBe("succeeded"); expect(replay.executionStatus).toBe("succeeded");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(1);
    const audit = await db.select().from(activityLog).where(eq(activityLog.action, "decision.effect_executed"));
    expect(audit[0]?.responsibleUserId).toBe(decidedByUserId);
    expect(audit[0]?.details).toMatchObject({ decidedByUserId, originResponsibleUserId });
    expect(first.executions[0]?.activityLogId).toBe(audit[0]?.id);
    expect(wakes).toHaveLength(1);
  });

  it("allows one double-decide winner and rejects the loser", async () => {
    const created = await createCommentDecision();
    const outcomes = await Promise.allSettled([
      service().decide({ id: created.id, optionId: "yes", idempotencyKey: "race-a", decidedByUserId, userActor: boardActor() }),
      service().decide({ id: created.id, optionId: "yes", idempotencyKey: "race-b", decidedByUserId, userActor: boardActor() }),
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(1);
  });

  it("skips strict stale targets and fails closed on intersection denial", async () => {
    const stale = await createCommentDecision("strict");
    await db.update(issues).set({ updatedAt: new Date(Date.now() + 1_000) }).where(eq(issues.id, targetIssueId));
    const staleResult = await service().decide({ id: stale.id, optionId: "yes", decidedByUserId, userActor: boardActor() });
    expect(staleResult.executions[0]).toMatchObject({ status: "skipped", error: "target_changed" });

    const denied = await createCommentDecision("lenient", { idempotencyKey: "denied" });
    const deniedResult = await service().decide({ id: denied.id, optionId: "yes", decidedByUserId, userActor: { type: "none", source: "none" } });
    expect(deniedResult.executions[0]).toMatchObject({ status: "failed", error: "deny_decision_intersection" });
    const failedAudit = await db.select().from(activityLog).where(eq(activityLog.action, "decision.effect_failed"));
    expect(failedAudit.at(-1)?.details).toMatchObject({ reason: "deny_decision_intersection" });
  });

  it("fails closed when the origin actor retains read access but loses mutation access", async () => {
    const created = await service().create({
      companyId, actor: agentActor(), agentId, runId, title: "Update?", body: "Body",
      options: [{ id: "yes", label: "Yes", effects: [{ type: "update_issue_status", targetIssueId, staleness: "lenient", status: "in_progress" }] }],
    });
    await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(eq(companyMemberships.principalId, originResponsibleUserId));
    const result = await service().decide({ id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor() });
    expect(result.executions[0]).toMatchObject({ status: "failed", error: "deny_decision_intersection" });
  });

  it("expires a decision atomically instead of executing after its deadline", async () => {
    const created = await createCommentDecision("lenient", { expiresAt: new Date(Date.now() + 5) });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(service().decide({ id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor() }))
      .rejects.toThrow("decision_expired");
    expect((await service().get(created.id))?.status).toBe("expired");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(0);
  });

  it("rejects strict effects when secondary targets or cancellation scope change", async () => {
    const blockerId = randomUUID();
    await db.insert(issues).values({ id: blockerId, companyId, title: "Blocker", status: "todo", priority: "medium", responsibleUserId: decidedByUserId });
    const createDecision = await service().create({
      companyId, actor: agentActor(), agentId, runId, title: "Create?", body: "Body",
      options: [{ id: "yes", label: "Yes", effects: [{ type: "create_issue", targetIssueId, staleness: "strict", draft: { title: "Follow-up", blockedByIssueIds: [blockerId] } }] }],
    });
    await db.update(issues).set({ updatedAt: new Date(Date.now() + 1_000) }).where(eq(issues.id, blockerId));
    const createResult = await service().decide({ id: createDecision.id, optionId: "yes", decidedByUserId, userActor: boardActor() });
    expect(createResult.executions[0]).toMatchObject({ status: "skipped", error: "target_changed" });

    const cancelDecision = await service().create({
      companyId, actor: agentActor(), agentId, runId, title: "Cancel?", body: "Body",
      options: [{ id: "yes", label: "Yes", effects: [{ type: "cancel_issue_tree", targetIssueId, staleness: "strict", reasonComment: "cleanup" }] }],
    });
    const childId = randomUUID();
    await db.insert(issues).values({ id: childId, companyId, title: "New child", status: "todo", priority: "medium", parentId: targetIssueId, responsibleUserId: decidedByUserId });
    const cancelResult = await service().decide({ id: cancelDecision.id, optionId: "yes", decidedByUserId, userActor: boardActor() });
    expect(cancelResult.executions[0]).toMatchObject({ status: "skipped", error: "target_changed" });
    expect((await db.select().from(issues).where(eq(issues.id, childId)))[0]?.status).toBe("todo");
  });

  it("fails closed when the deciding user lacks assignment capability", async () => {
    const assigneeAgentId = randomUUID();
    await db.insert(agents).values({ id: assigneeAgentId, companyId, name: "Assignee", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    const created = await service().create({
      companyId, actor: agentActor(), agentId, runId, title: "Assign?", body: "Body",
      options: [{ id: "yes", label: "Yes", effects: [{ type: "assign_issue", targetIssueId, staleness: "lenient", assigneeAgentId }] }],
    });
    await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(eq(companyMemberships.principalId, decidedByUserId));
    const result = await service().decide({ id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor() });
    expect(result.executions[0]).toMatchObject({ status: "failed", error: "deny_decision_intersection" });
  });

  it("fails closed when the origin responsible user loses visibility", async () => {
    const created = await createCommentDecision();
    await db.update(companyMemberships).set({ status: "inactive" }).where(eq(companyMemberships.principalId, originResponsibleUserId));
    const result = await service().decide({ id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor() });
    expect(result.executions[0]).toMatchObject({ status: "failed", error: "deny_decision_intersection" });
    expect(result.executions[0]?.result).toMatchObject({ originReason: "deny_missing_membership" });
  });

  it("refuses execution when the decision signing secret is unavailable", async () => {
    const created = await createCommentDecision();
    delete process.env.PAPERCLIP_DECISION_SIGNING_SECRET;
    await expect(service().decide({ id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor() }))
      .rejects.toThrow("PAPERCLIP_DECISION_SIGNING_SECRET is required");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(0);
  });

  it("records a failed effect and continues independent later effects", async () => {
    const created = await service().create({
      companyId, actor: agentActor(), agentId, runId, title: "Continue?", body: "Body",
      options: [{ id: "yes", label: "Yes", effects: [
        { type: "update_issue_status", targetIssueId, staleness: "lenient", status: "in_progress" },
        { type: "comment_on_issue", targetIssueId, staleness: "lenient", bodyMarkdown: "still runs" },
      ] }],
    });
    const result = await service().decide({ id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor() });
    expect(result.executionStatus).toBe("partial");
    expect(result.executions).toEqual(expect.arrayContaining([
      expect.objectContaining({ effectIndex: 0, status: "failed", error: "effect_execution_failed" }),
      expect.objectContaining({ effectIndex: 1, status: "executed" }),
    ]));
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(1);
  });

  it("resumes claimed effects exactly once after a simulated crash", async () => {
    const created = await createCommentDecision();
    await db.update(decisions).set({ status: "decided", executionStatus: "running", chosenOptionId: "yes", decidedByUserId,
      inputValues: {}, metadata: { decideIdempotencyKey: "resume-key" } }).where(eq(decisions.id, created.id));
    await db.insert(decisionEffectExecutions).values({ decisionId: created.id, effectIndex: 0, effectType: "comment_on_issue", targetIssueId, status: "claimed" });
    const resumed = await service().decide({ id: created.id, optionId: "yes", idempotencyKey: "resume-key", decidedByUserId, userActor: boardActor() });
    expect(resumed.executionStatus).toBe("succeeded");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(1);
  });

  it("adds open decisions to the attention feed and badge count", async () => {
    const created = await createCommentDecision();
    const feed = await attentionService(db).list(companyId, { userId: decidedByUserId });
    expect(feed.countsBySourceKind.decision).toBe(1);
    expect(feed.items).toEqual(expect.arrayContaining([expect.objectContaining({
      sourceKind: "decision",
      subject: expect.objectContaining({ id: created.id, kind: "decision" }),
    })]));
  });

  it("bounds expiration work to the configured batch size", async () => {
    process.env.PAPERCLIP_DECISIONS_SWEEP_BATCH_SIZE = "1";
    await createCommentDecision("lenient", { idempotencyKey: "batch-1", expiresAt: new Date(Date.now() + 5) });
    await createCommentDecision("lenient", { idempotencyKey: "batch-2", expiresAt: new Date(Date.now() + 5) });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await service().sweepExpired()).expired).toBe(1);
    expect((await service().sweepExpired()).expired).toBe(1);
  });

  it("expires TTL and target-gone decisions and wakes the origin agent", async () => {
    const ttl = await createCommentDecision("lenient", { expiresAt: new Date(Date.now() + 5) });
    const gone = await createCommentDecision("strict", { idempotencyKey: "gone" });
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, targetIssueId));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await service().sweepExpired()).expired).toBe(2);
    const rows = await db.select().from(decisions);
    expect(rows.find((row) => row.id === ttl.id)?.metadata).toMatchObject({ expiredReason: "ttl" });
    expect(rows.find((row) => row.id === gone.id)?.metadata).toMatchObject({ expiredReason: "target_gone" });
    expect(wakes).toHaveLength(2);
  });

  it("groups rule-key stats and separates explicit dismissals from expiry", async () => {
    const accepted = await service().create({
      companyId, actor: agentActor(), agentId, runId, ruleKey: "routing.assign", title: "Assign?", body: "Body",
      options: [{ id: "assign", label: "Assign", effects: [] }, { id: "skip", label: "Skip", effects: [] }],
    });
    const rejected = await service().create({
      companyId, actor: agentActor(), agentId, runId, ruleKey: "routing.assign", title: "Assign another?", body: "Body",
      options: [{ id: "assign", label: "Assign", effects: [] }, { id: "skip", label: "Skip", effects: [] }],
    });
    await service().create({
      companyId, actor: agentActor(), agentId, runId, ruleKey: "cleanup.stale", title: "Clean up?", body: "Body",
      options: [{ id: "clean", label: "Clean", effects: [] }], expiresAt: new Date(Date.now() + 5),
    });
    await service().decide({ id: accepted.id, optionId: "assign", decidedByUserId, userActor: boardActor() });
    await service().dismiss(rejected.id, decidedByUserId, boardActor(), "Not this time");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await service().sweepExpired();

    const stats = await service().stats(companyId, { originAgentId: agentId });
    expect(stats.totals).toEqual({ proposed: 3, accepted: 1, rejected: 1, expired: 1 });
    expect(stats.groups).toEqual([
      { ruleKey: "cleanup.stale", proposed: 1, accepted: 0, rejected: 0, expired: 1, chosenOptions: [] },
      { ruleKey: "routing.assign", proposed: 2, accepted: 1, rejected: 1, expired: 0,
        chosenOptions: [{ optionId: "assign", count: 1 }] },
    ]);
    expect((await service().outcome(rejected.id)).metadata).toMatchObject({ dismissed: true, dismissReason: "Not this time" });
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "decision.dismissed")))
      .toEqual([expect.objectContaining({ entityId: rejected.id, responsibleUserId: decidedByUserId })]);
  });
});
