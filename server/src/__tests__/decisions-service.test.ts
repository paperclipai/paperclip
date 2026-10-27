import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  withDedicatedDbConnection,
  decisionEffectExecutions,
  decisionRetention,
  decisions,
  decisionTargetIssues,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { attentionService } from "../services/attention.js";
import { decisionService } from "../services/decisions.js";
import * as retentionModule from "../services/decision-retention.js";
import { hashAttentionArchiveManifest } from "../services/decision-retention.js";
import type { AttentionArchiveManifestEntry, AttentionArchiveTargetSnapshot } from "@paperclipai/shared";

import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { decisionContinuationService } from "../services/decision-continuations.js";
import { registerDecisionContinuationWork } from "../services/decision-continuation-work.js";
import { writeDecisionChange } from "../services/decision-work-notifications.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_DECISIONS_TEST_DATABASE_URL");
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
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

  let stopWorker: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    if (!externalUrl) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-decisions-");
    db = createDb(externalUrl ?? tempDb!.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
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
    await stopWorker?.(); stopWorker = undefined;
    delete process.env.PAPERCLIP_DECISIONS_SWEEP_BATCH_SIZE;
    delete process.env.PAPERCLIP_DECISIONS_RECOVERY_GRACE_MS;
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    await db.delete(decisionEffectExecutions); await db.delete(decisionTargetIssues); await db.delete(decisions); await db.delete(decisionRetention); await db.delete(activityLog);
    await db.delete(issueComments); await db.delete(issueRelations); await db.delete(heartbeatRuns); await db.delete(issues); await db.delete(agents); await db.delete(companyMemberships); await db.delete(authUsers); await db.delete(companies);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await tempDb?.cleanup(); });

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
  // Make an existing decision TTL-expired for the next sweep. Creating a
  // decision that is already expired is impossible (create rejects a past
  // expiresAt), and creating one that expires a few milliseconds later races
  // the service's own clock read — under CI load the create itself can fail
  // with "expiresAt must be within 30 days". Create with a comfortable future
  // expiry instead, then move expiresAt into the past directly in the store.
  const nearFutureExpiry = () => new Date(Date.now() + 60_000);
  const expireDecisionNow = (id: string) =>
    db.update(decisions).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(decisions.id, id));

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
    // Repeating the same option is a valid replay if the first request already
    // won. Distinct choices exercise contention regardless of query scheduling.
    const created = await createCommentDecision("lenient", { options: [
      { id: "yes", label: "Yes", effects: [{ type: "comment_on_issue", targetIssueId, staleness: "lenient", bodyMarkdown: "hello" }] },
      { id: "alternative", label: "Alternative", effects: [{ type: "comment_on_issue", targetIssueId, staleness: "lenient", bodyMarkdown: "alternative" }] },
    ] });
    const outcomes = await Promise.allSettled([
      service().decide({ id: created.id, optionId: "yes", idempotencyKey: "race-a", decidedByUserId, userActor: boardActor() }),
      service().decide({ id: created.id, optionId: "alternative", idempotencyKey: "race-b", decidedByUserId, userActor: boardActor() }),
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(1);
  });

  it("binds bulk archive acceptance to the exact signed, versioned manifest", async () => {
    const extraIssueId = randomUUID();
    const unreviewedIssueId = randomUUID();
    await db.insert(issues).values([
      { id: extraIssueId, companyId, title: "Second aging item", status: "in_review", priority: "medium", createdByAgentId: agentId, assigneeUserId: decidedByUserId },
      { id: unreviewedIssueId, companyId, title: "Not reviewed", status: "in_review", priority: "medium", createdByAgentId: agentId, assigneeUserId: decidedByUserId },
    ]);
    const activityAt = new Date("2026-04-01T00:00:00.000Z");
    await db.insert(decisionRetention).values([targetIssueId, extraIssueId, unreviewedIssueId].map((sourceId) => ({
      companyId,
      sourceKind: "review",
      sourceId,
      sourceActivityAt: activityAt,
    })));
    const manifest: AttentionArchiveManifestEntry[] = [targetIssueId, extraIssueId].map((sourceId) => ({
      companyId,
      sourceKind: "review",
      sourceId,
      expectedVersion: 1,
      activityAt: activityAt.toISOString(),
      reason: `Archive ${sourceId}`,
    }));
    const snapshots = Object.fromEntries(manifest.map((entry) => [
      `attention:${entry.sourceKind}:${entry.sourceId}`,
      {
        status: "attention",
        assigneeAgentId: null,
        assigneeUserId: null,
        updatedAt: entry.activityAt,
        attentionArchive: entry,
      } satisfies AttentionArchiveTargetSnapshot,
    ]));
    const created = await service().create({
      companyId,
      actor: agentActor(),
      agentId,
      runId,
      title: "Archive two?",
      body: "Reviewed exact set",
      options: [
        { id: "archive", label: "Archive", style: "destructive", effects: [] },
        { id: "keep", label: "Keep", effects: [] },
      ],
      metadata: { kind: "attention_archive_proposal", manifestHash: hashAttentionArchiveManifest(manifest) },
      additionalTargetSnapshots: snapshots,
    });
    const result = await service().decide({
      id: created.id,
      optionId: "archive",
      decidedByUserId,
      userActor: boardActor(),
    });
    expect(result.executionStatus).toBe("succeeded");
    const states = await db.select().from(decisionRetention);
    expect(states.filter((row) => row.archivedAt).map((row) => row.sourceId).sort()).toEqual([extraIssueId, targetIssueId].sort());
    expect(states.find((row) => row.sourceId === unreviewedIssueId)?.archivedAt).toBeNull();
  });

  it.each(["invalid_signature", "manifest_mismatch", "archive_failure"] as const)("delivers a recovered archive failure without inherited pending metadata: %s", async failure => {
    const activityAt = new Date("2026-04-01T00:00:00.000Z");
    const manifest: AttentionArchiveManifestEntry[] = [{ companyId, sourceKind: "review", sourceId: targetIssueId,
      expectedVersion: 1, activityAt: activityAt.toISOString(), reason: "Archive" }];
    const row = await service().create({ companyId, actor: agentActor(), agentId, runId, title: "Archive?", body: "Exact set",
      continuationPolicy: "wake_origin_agent", options: [{ id: "archive", label: "Archive", effects: [] }],
      metadata: { kind: "attention_archive_proposal", manifestHash: failure === "manifest_mismatch" ? "incorrect" : hashAttentionArchiveManifest(manifest) },
      additionalTargetSnapshots: { [`attention:review:${targetIssueId}`]: { status: "attention", assigneeAgentId: null,
        assigneeUserId: null, updatedAt: activityAt.toISOString(), attentionArchive: manifest[0] } } });
    await db.update(decisions).set({ status: "decided", executionStatus: "running", chosenOptionId: "archive",
      decidedByUserId, decidedAt: new Date(), updatedAt: new Date(Date.now() - 120_000),
      ...(failure === "invalid_signature" ? { signedSpec: "invalid" } : {}),
      metadata: { ...row.metadata, continuationPending: false } }).where(eq(decisions.id, row.id));
    const original = retentionModule.decisionRetentionService;
    const factory = failure === "archive_failure" ? vi.spyOn(retentionModule, "decisionRetentionService").mockImplementation((source, options) => ({
      ...original(source, options), archiveReviewedManifest: async () => { throw new Error("archive_failure"); },
    })) : undefined;
    try {
      expect(await service().sweepExpired()).toMatchObject({ resumed: 1 });
      const saved = await service().get(row.id);
      expect(saved).toMatchObject({ executionStatus: "failed", metadata: { archiveProposalError: failure, continuationPending: false } });
      expect(saved!.metadata.continuationDeliveredAt).toEqual(expect.any(String));
      expect(wakes).toHaveLength(1);
      await service().sweepExpired();
      expect(wakes).toHaveLength(1);
    } finally { factory?.mockRestore(); }
  });

  it("serializes concurrent archive completion before reporting its outcome", async () => {
    await db.update(issues).set({ status: "in_review", assigneeUserId: decidedByUserId }).where(eq(issues.id, targetIssueId));
    const activityAt = new Date("2026-04-01T00:00:00.000Z");
    await db.insert(decisionRetention).values({ companyId, sourceKind: "review", sourceId: targetIssueId, sourceActivityAt: activityAt });
    const manifest: AttentionArchiveManifestEntry[] = [{ companyId, sourceKind: "review", sourceId: targetIssueId,
      expectedVersion: 1, activityAt: activityAt.toISOString(), reason: "Archive" }];
    const row = await service().create({ companyId, actor: agentActor(), agentId, runId, title: "Archive?", body: "Exact set",
      continuationPolicy: "wake_origin_agent", options: [{ id: "archive", label: "Archive", effects: [] }],
      metadata: { kind: "attention_archive_proposal", manifestHash: hashAttentionArchiveManifest(manifest) },
      additionalTargetSnapshots: { [`attention:review:${targetIssueId}`]: { status: "attention", assigneeAgentId: null,
        assigneeUserId: null, updatedAt: activityAt.toISOString(), attentionArchive: manifest[0] } } });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = retentionModule.decisionRetentionService;
    let archived = false, calls = 0;
    const factory = vi.spyOn(retentionModule, "decisionRetentionService").mockImplementation((source, options) => {
      const actual = original(source, options);
      return { ...actual, archiveReviewedManifest: async input => {
        calls++;
        const result = await actual.archiveReviewedManifest(input);
        archived = true; await gate; return result;
      } };
    });
    const decide = () => service().decide({ id: row.id, optionId: "archive", decidedByUserId, userActor: boardActor() });
    const first = decide();
    let second: ReturnType<typeof decide> | undefined;
    try {
      await vi.waitFor(() => expect(archived).toBe(true));
      await withDedicatedDbConnection(db, async contender => {
        let observed!: () => void;
        const readStarted = new Promise<void>(resolve => { observed = resolve; });
        let decisionReads = 0;
        contender.$client.options.debug = (_id, query) => {
          if (/^select/i.test(query) && query.includes('from "decisions"')) { decisionReads++; observed(); }
        };
        try {
          second = decisionService(contender, { wakeOriginAgent: async input => { wakes.push(input); } })
            .decide({ id: row.id, optionId: "archive", decidedByUserId, userActor: boardActor() });
          await readStarted;
          await contender.execute(sql`select 1`);
          await contender.execute(sql`select 1`);
          expect(decisionReads).toBe(1);
          release();
          const results = await Promise.all([first, second]);
          expect(results.map(result => result.executionStatus)).toEqual(["succeeded", "succeeded"]);
          expect(calls).toBe(1); expect(wakes).toHaveLength(1);
          const [state] = await db.select().from(decisionRetention);
          expect(state.archiveVersion).toBe(1); expect(state.archivedAt).not.toBeNull();
        } finally { release(); await Promise.allSettled([first, ...(second ? [second] : [])]); }
      });
    } finally { release(); await Promise.allSettled([first, ...(second ? [second] : [])]); factory.mockRestore(); }
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

  it("removes inbound blockers without replacing them with outgoing relations", async () => {
    const removedBlockerId = randomUUID();
    const retainedBlockerId = randomUUID();
    const downstreamId = randomUUID();
    await db.insert(issues).values([
      { id: removedBlockerId, companyId, title: "Removed blocker", status: "todo", priority: "medium", responsibleUserId: decidedByUserId },
      { id: retainedBlockerId, companyId, title: "Retained blocker", status: "todo", priority: "medium", responsibleUserId: decidedByUserId },
      { id: downstreamId, companyId, title: "Downstream", status: "todo", priority: "medium", responsibleUserId: decidedByUserId },
    ]);
    await db.insert(issueRelations).values([
      { companyId, issueId: removedBlockerId, relatedIssueId: targetIssueId, type: "blocks" },
      { companyId, issueId: retainedBlockerId, relatedIssueId: targetIssueId, type: "blocks" },
      { companyId, issueId: targetIssueId, relatedIssueId: downstreamId, type: "blocks" },
    ]);
    const created = await service().create({
      companyId, actor: agentActor(), agentId, runId, title: "Resolve blocker?", body: "Body",
      options: [{ id: "yes", label: "Yes", effects: [{ type: "resolve_blocker", targetIssueId, staleness: "lenient",
        removeBlockedByIssueIds: [removedBlockerId] }] }],
    });

    await service().decide({ id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor() });

    const relations = await db.select().from(issueRelations).where(eq(issueRelations.companyId, companyId));
    expect(relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ issueId: retainedBlockerId, relatedIssueId: targetIssueId, type: "blocks" }),
      expect.objectContaining({ issueId: targetIssueId, relatedIssueId: downstreamId, type: "blocks" }),
    ]));
    expect(relations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ issueId: removedBlockerId, relatedIssueId: targetIssueId, type: "blocks" }),
    ]));
  });

  it("rejects mutation proposals from an origin actor with read-only access", async () => {
    await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(eq(companyMemberships.principalId, originResponsibleUserId));
    const readOnlyActor = { ...agentActor(),
      onBehalfOfMemberships: [{ companyId, membershipRole: "viewer" as const, status: "active" as const }] };

    await expect(service().create({
      companyId, actor: readOnlyActor, agentId, runId, title: "Update?", body: "Body",
      options: [{ id: "yes", label: "Yes", effects: [{
        type: "update_issue_status", targetIssueId, staleness: "lenient", status: "in_progress",
      }] }],
    })).rejects.toThrow("Decision effect exceeds the origin authority boundary");
  });

  it("expires a decision atomically instead of executing after its deadline", async () => {
    const created = await createCommentDecision("lenient");
    await db.update(decisions).set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(decisions.id, created.id));
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

  it("never expands a lenient cancellation beyond the signed descendant scope", async () => {
    const reviewedChildId = randomUUID();
    await db.insert(issues).values({ id: reviewedChildId, companyId, title: "Reviewed child", status: "todo", priority: "medium",
      parentId: targetIssueId, responsibleUserId: decidedByUserId });
    const created = await service().create({
      companyId, actor: agentActor(), agentId, runId, title: "Cancel?", body: "Body",
      options: [{ id: "yes", label: "Yes", effects: [{
        type: "cancel_issue_tree", targetIssueId, staleness: "lenient", reasonComment: "cleanup",
      }] }],
    });
    const unreviewedChildId = randomUUID();
    await db.insert(issues).values({ id: unreviewedChildId, companyId, title: "Unreviewed child", status: "todo", priority: "medium",
      parentId: targetIssueId, responsibleUserId: decidedByUserId });

    const result = await service().decide({ id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor() });

    expect(result.executions[0]).toMatchObject({ status: "executed",
      result: { cancelledIssueIds: [reviewedChildId, targetIssueId] } });
    expect((await db.select().from(issues).where(eq(issues.id, unreviewedChildId)))[0]?.status).toBe("todo");
  });

  it("bounds cyclic issue traversal for snapshots and cancel-tree execution", async () => {
    const childId = randomUUID();
    await db.insert(issues).values({ id: childId, companyId, title: "Cycle child", status: "todo", priority: "medium",
      parentId: targetIssueId, responsibleUserId: decidedByUserId });
    await db.update(issues).set({ parentId: childId }).where(eq(issues.id, targetIssueId));
    const created = await service().create({
      companyId, actor: agentActor(), agentId, runId, title: "Cancel cycle?", body: "Body",
      options: [{ id: "cancel", label: "Cancel", style: "destructive", effects: [{
        type: "cancel_issue_tree", targetIssueId, staleness: "strict", reasonComment: "cleanup",
      }] }],
    });

    expect((created.targetSnapshots as Record<string, { descendantCount: number }>)[targetIssueId]?.descendantCount).toBe(1);
    const result = await service().decide({ id: created.id, optionId: "cancel", decidedByUserId, userActor: boardActor() });
    expect(result.executions[0]).toMatchObject({ status: "executed", result: { cancelledIssueIds: [childId, targetIssueId] } });
    expect(await db.select({ id: issues.id, status: issues.status }).from(issues).where(eq(issues.companyId, companyId)))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: targetIssueId, status: "cancelled" }),
        expect.objectContaining({ id: childId, status: "cancelled" }),
      ]));
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

  it("fails closed when the configured signing secret is removed after proposal", async () => {
    const created = await createCommentDecision();
    const originalHome = process.env.PAPERCLIP_HOME;
    const tempHome = mkdtempSync(path.join(tmpdir(), "paperclip-decision-rotate-"));
    process.env.PAPERCLIP_HOME = tempHome;
    delete process.env.PAPERCLIP_DECISION_SIGNING_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "agent-jwt-secret-must-not-sign-decisions";
    try {
      await expect(service().decide({ id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor() }))
        .rejects.toThrow("Decision signature verification failed");
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(0);
    } finally {
      if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = originalHome;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("signs and verifies with an auto-generated key when no secret is configured", async () => {
    const originalHome = process.env.PAPERCLIP_HOME;
    const tempHome = mkdtempSync(path.join(tmpdir(), "paperclip-decision-generated-"));
    process.env.PAPERCLIP_HOME = tempHome;
    delete process.env.PAPERCLIP_DECISION_SIGNING_SECRET;
    try {
      const created = await createCommentDecision();
      const result = await service().decide({ id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor() });
      expect(result.executionStatus).toBe("succeeded");
    } finally {
      if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = originalHome;
      rmSync(tempHome, { recursive: true, force: true });
    }
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

  it("resumes claimed effects exactly once after a simulated crash without a client idempotency key", async () => {
    const created = await createCommentDecision();
    await db.update(decisions).set({ status: "decided", executionStatus: "running", chosenOptionId: "yes", decidedByUserId,
      inputValues: {} }).where(eq(decisions.id, created.id));
    await db.insert(decisionEffectExecutions).values({ decisionId: created.id, effectIndex: 0, effectType: "comment_on_issue", targetIssueId, status: "claimed" });
    const resumed = await service().decide({ id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor() });
    expect(resumed.executionStatus).toBe("succeeded");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(1);
  });

  it("recovers stale running decisions from the bounded server sweep", async () => {
    process.env.PAPERCLIP_DECISIONS_RECOVERY_GRACE_MS = "0";
    const created = await createCommentDecision();
    await db.update(decisions).set({ status: "decided", executionStatus: "running", chosenOptionId: "yes", decidedByUserId,
      inputValues: {}, updatedAt: new Date(Date.now() - 1_000) }).where(eq(decisions.id, created.id));
    await db.insert(decisionEffectExecutions).values({ decisionId: created.id, effectIndex: 0, effectType: "comment_on_issue",
      targetIssueId, status: "claimed" });

    expect(await service().sweepExpired()).toEqual({ expired: 0, resumed: 1 });
    expect((await service().get(created.id))?.executionStatus).toBe("succeeded");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(1);
    expect(wakes).toEqual([{ companyId, agentId, issueId: originIssueId, decisionId: created.id, outcome: "decided" }]);
  });

  it("retries a terminal continuation after a crash between effects and wake delivery", async () => {
    const created = await createCommentDecision();
    const crashingService = decisionService(db, { wakeOriginAgent: async () => {
      throw new Error("simulated post-execution crash");
    } });

    await expect(crashingService.decide({ id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor() }))
      .rejects.toThrow("simulated post-execution crash");
    expect((await service().get(created.id))?.executionStatus).toBe("succeeded");
    expect((await service().get(created.id))?.metadata).toMatchObject({ continuationPending: true });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(1);

    await service().sweepExpired();

    expect(wakes).toEqual([{ companyId, agentId, issueId: originIssueId, decisionId: created.id, outcome: "decided" }]);
    expect((await service().get(created.id))?.metadata).toMatchObject({ continuationPending: false });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(1);
  });

  it("delivers the continuation when the origin agent cancels a decision", async () => {
    const created = await createCommentDecision();

    const cancelled = await service().cancel(created.id, { actorType: "agent", actorId: agentId, runId });

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.metadata).toMatchObject({ continuationPending: false });
    expect(wakes).toEqual([{ companyId, agentId, issueId: originIssueId, decisionId: created.id, outcome: "cancelled" }]);
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

  it("batches effect executions into terminal decision lists", async () => {
    const created = await createCommentDecision();
    await service().decide({ id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor() });

    const listed = await service().list(companyId, { status: "decided" });

    expect(listed).toEqual(expect.arrayContaining([expect.objectContaining({
      id: created.id,
      executions: [expect.objectContaining({ effectIndex: 0, status: "executed" })],
    })]));
  });

  it("bounds the open-decision slice of the attention feed", async () => {
    const older = await createCommentDecision("lenient", { idempotencyKey: "attention-older" });
    const newer = await createCommentDecision("lenient", { idempotencyKey: "attention-newer" });
    await db.update(decisions).set({ updatedAt: new Date(Date.now() - 1_000) }).where(eq(decisions.id, older.id));

    const feed = await attentionService(db, { openDecisionLimit: 1 }).list(companyId, { userId: decidedByUserId });

    expect(feed.countsBySourceKind.decision).toBe(1);
    expect(feed.items.filter((item) => item.sourceKind === "decision").map((item) => item.subject.id)).toEqual([newer.id]);
  });

  it("loads target staleness in a bounded query for the open-decision list", async () => {
    const first = await createCommentDecision("lenient", { idempotencyKey: "list-query-1" });
    const second = await createCommentDecision("lenient", { idempotencyKey: "list-query-2" });
    await db.update(issues).set({ updatedAt: new Date(Date.now() + 1_000) }).where(eq(issues.id, targetIssueId));

    const selectSpy = vi.spyOn(db, "select");
    try {
      const listed = await service().list(companyId, { status: "open" });
      expect(selectSpy).toHaveBeenCalledTimes(2);
      expect(listed.filter((decision) => decision.id === first.id || decision.id === second.id))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ id: first.id, targetChanged: { [targetIssueId]: true } }),
          expect.objectContaining({ id: second.id, targetChanged: { [targetIssueId]: true } }),
        ]));
    } finally {
      selectSpy.mockRestore();
    }
  });

  it("bounds expiration work to the configured batch size", async () => {
    process.env.PAPERCLIP_DECISIONS_SWEEP_BATCH_SIZE = "1";
    const first = await createCommentDecision("lenient", { idempotencyKey: "batch-1", expiresAt: nearFutureExpiry() });
    const second = await createCommentDecision("lenient", { idempotencyKey: "batch-2", expiresAt: nearFutureExpiry() });
    await expireDecisionNow(first.id);
    await expireDecisionNow(second.id);
    expect((await service().sweepExpired()).expired).toBe(1);
    expect((await service().sweepExpired()).expired).toBe(1);
  });

  it("falls back to the default sweep batch size for invalid configuration", async () => {
    process.env.PAPERCLIP_DECISIONS_SWEEP_BATCH_SIZE = "not-a-number";
    const first = await createCommentDecision("lenient", { idempotencyKey: "invalid-batch-1", expiresAt: nearFutureExpiry() });
    const second = await createCommentDecision("lenient", { idempotencyKey: "invalid-batch-2", expiresAt: nearFutureExpiry() });
    await expireDecisionNow(first.id);
    await expireDecisionNow(second.id);

    await expect(service().sweepExpired()).resolves.toMatchObject({ expired: 2 });
  });

  it("expires TTL and target-gone decisions and wakes the origin agent", async () => {
    const ttl = await createCommentDecision("lenient", { expiresAt: nearFutureExpiry() });
    const gone = await createCommentDecision("strict", { idempotencyKey: "gone" });
    await db.update(decisions).set({ expiresAt: new Date(0) }).where(eq(decisions.id, ttl.id));
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, targetIssueId));
    await expireDecisionNow(ttl.id);
    expect((await service().sweepExpired()).expired).toBe(2);
    const rows = await db.select().from(decisions);
    expect(rows.find((row) => row.id === ttl.id)?.metadata).toMatchObject({ expiredReason: "ttl" });
    expect(rows.find((row) => row.id === gone.id)?.metadata).toMatchObject({ expiredReason: "target_gone" });
    expect(wakes).toHaveLength(2);
  });

  it("expires strict decisions whose targets completed after they were proposed", async () => {
    const completed = await createCommentDecision("strict", { idempotencyKey: "target-completed" });
    const lenient = await createCommentDecision("lenient", { idempotencyKey: "lenient-survives" });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, targetIssueId));

    expect((await service().sweepExpired()).expired).toBe(1);

    expect((await service().get(completed.id))?.metadata).toMatchObject({ expiredReason: "target_completed" });
    expect((await service().get(lenient.id))?.status).toBe("open");
    expect(wakes).toEqual([{ companyId, agentId, issueId: originIssueId, decisionId: completed.id, outcome: "expired" }]);
  });

  it("keeps strict decisions that intentionally target an already-done issue", async () => {
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, targetIssueId));
    const reopen = await createCommentDecision("strict", { idempotencyKey: "already-done" });

    expect((await service().sweepExpired()).expired).toBe(0);
    expect((await service().get(reopen.id))?.status).toBe("open");
  });

  it("expires when a strict secondary target completes after proposal", async () => {
    const blockerId = randomUUID();
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, targetIssueId));
    await db.insert(issues).values({
      id: blockerId,
      companyId,
      title: "Secondary blocker",
      status: "todo",
      priority: "medium",
      responsibleUserId: decidedByUserId,
    });
    const created = await service().create({
      companyId,
      actor: agentActor(),
      agentId,
      runId,
      title: "Create follow-up?",
      body: "Body",
      options: [{
        id: "yes",
        label: "Yes",
        effects: [{
          type: "create_issue",
          targetIssueId,
          staleness: "strict",
          draft: { title: "Follow-up", blockedByIssueIds: [blockerId] },
        }],
      }],
    });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockerId));

    expect((await service().sweepExpired()).expired).toBe(1);
    expect((await service().get(created.id))?.metadata).toMatchObject({ expiredReason: "target_completed" });
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
    const acceptedAgain = await service().create({
      companyId, actor: agentActor(), agentId, runId, ruleKey: "routing.assign", title: "Assign again?", body: "Body",
      options: [{ id: "assign", label: "Assign", effects: [] }, { id: "skip", label: "Skip", effects: [] }],
    });
    const stale = await service().create({
      companyId, actor: agentActor(), agentId, runId, ruleKey: "cleanup.stale", title: "Clean up?", body: "Body",
      options: [{ id: "clean", label: "Clean", effects: [] }], expiresAt: nearFutureExpiry(),
    });
    await service().decide({ id: accepted.id, optionId: "assign", decidedByUserId, userActor: boardActor() });
    await service().decide({ id: acceptedAgain.id, optionId: "assign", decidedByUserId, userActor: boardActor() });
    await service().dismiss(rejected.id, decidedByUserId, boardActor(), "Not this time");
    await expireDecisionNow(stale.id);
    await service().sweepExpired();

    const stats = await service().stats(companyId, { originAgentId: agentId });
    expect(stats.filters).toEqual({ originAgentId: agentId, since: null });
    expect(stats.totals).toEqual({ proposed: 4, accepted: 2, rejected: 1, expired: 1 });
    expect(stats.groups).toEqual([
      { ruleKey: "cleanup.stale", proposed: 1, accepted: 0, rejected: 0, expired: 1, chosenOptions: [] },
      { ruleKey: "routing.assign", proposed: 3, accepted: 2, rejected: 1, expired: 0,
        chosenOptions: [{ optionId: "assign", count: 2 }] },
    ]);
    expect((await service().outcome(rejected.id)).metadata).toMatchObject({ dismissed: true, dismissReason: "Not this time" });
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "decision.dismissed")))
      .toEqual([expect.objectContaining({ entityId: rejected.id, responsibleUserId: decidedByUserId })]);
  });

  it("rejects a direct dismissal when the signed decision spec was tampered with", async () => {
    const created = await createCommentDecision();
    await db.update(decisions).set({ options: [{ id: "tampered", label: "Tampered", effects: [{
      type: "comment_on_issue", targetIssueId, staleness: "lenient", bodyMarkdown: "tampered",
    }] }] }).where(eq(decisions.id, created.id));

    await expect(service().dismiss(created.id, decidedByUserId, boardActor(), "No"))
      .rejects.toThrow("Decision signature verification failed");
    expect((await service().get(created.id))?.status).toBe("open");
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "decision.dismissed"))).toHaveLength(0);
  });

  it("wakes the origin agent after a direct dismissal", async () => {
    const created = await createCommentDecision();
    const result = await service().dismiss(created.id, decidedByUserId, boardActor(), "No");

    expect(result).toMatchObject({ status: "decided", chosenOptionId: "dismissed" });
    expect(wakes).toEqual([{ companyId, agentId, issueId: originIssueId, decisionId: created.id, outcome: "decided" }]);
  });
  describe("continuation worker", () => {
    let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
    let draining: boolean;
    const errors: unknown[] = [];
    const wake = vi.fn(async (_input: Record<string, unknown>) => {});
    const workerService = () => decisionService(db, { wakeOriginAgent: wake });

    beforeEach(async () => {
      await Promise.all(Array.from({ length: 6 }, () => db.execute(sql`select pg_sleep(0.01)`)));
      draining = false; errors.length = 0; wake.mockReset();
      stopWorker = async () => {
        await coordinator?.stop(); coordinator = undefined;
        vi.useRealTimers(); vi.restoreAllMocks();
        await db.execute(sql`drop trigger if exists decision_ack_fail on decisions`);
        await db.execute(sql`drop function if exists decision_ack_fail()`);
        expect(errors).toEqual([]);
      };
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: true });
    });
    async function start(svc = workerService()) {
      coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !draining,
        canReconcile: () => true, onError: error => errors.push(error) });
      await registerDecisionContinuationWork(coordinator, svc, () => !draining).ready;
    }
    async function quiet() {
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
        expect(idleWorkSnapshot().active).toBe(0);
        expect(coordinator!.nextWakeAt()).toBeNull();
      }, { timeout: 5000 });
      const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "update"), executes = vi.spyOn(db, "execute");
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); expect(executes).not.toHaveBeenCalled();
      reads.mockRestore(); writes.mockRestore(); executes.mockRestore();
    }
    async function pending(id: string) {
      expect((await service().get(id))?.metadata.continuationPending).toBe(true);
    }
    async function delivered(id: string) {
      expect((await service().get(id))?.metadata.continuationPending).toBe(false);
    }
    const markReady = (id: string, source = db) => writeDecisionChange(source, async tx => tx.update(decisions)
      .set({ status: "cancelled", metadata: { continuationPending: true } }).where(eq(decisions.id, id)));

    it("coalesces sequential tenant writes without dropping pending recovery", async () => {
      const row = await createCommentDecision();
      const svc = workerService(), sweep = vi.spyOn(svc, "sweepContinuations");
      await start(svc); await quiet(); sweep.mockClear();
      await svc.cancel(row.id, { actorType: "agent", actorId: agentId });
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
      expect(sweep).toHaveBeenCalledTimes(1);
      for (let i = 0; i < 5; i++) {
        const next = await createCommentDecision();
        await svc.cancel(next.id, { actorType: "agent", actorId: agentId });
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect(sweep).toHaveBeenCalledTimes(1);
      const recovery = await createCommentDecision();
      await markReady(recovery.id);
      await vi.advanceTimersByTimeAsync(1000);
      await pending(recovery.id);
      expect(sweep).toHaveBeenCalledTimes(1);
      await quiet(); await delivered(recovery.id);
      expect(sweep).toHaveBeenCalledTimes(2);
      expect(wake.mock.calls.filter(([input]) => input.decisionId === recovery.id)).toHaveLength(1);
    });

    it.each(["decide", "cancel", "dismiss", "expire"] as const)("reactivates from real %s and leaves delivered history quiet", async action => {
      const row = await createCommentDecision();
      await start(); await quiet();
      const svc = workerService();
      if (action === "decide") await svc.decide({ id: row.id, optionId: "yes", decidedByUserId, userActor: boardActor() });
      if (action === "cancel") await svc.cancel(row.id, { actorType: "agent", actorId: agentId });
      if (action === "dismiss") await svc.dismiss(row.id, decidedByUserId, boardActor());
      if (action === "expire") { await expireDecisionNow(row.id); await svc.sweepExpired(new Date(), { includeContinuations: false }); }
      await quiet(); await delivered(row.id);
      expect(wake).toHaveBeenCalledTimes(1);
      expect(wake.mock.calls[0][0]).toMatchObject({ decisionId: row.id, companyId, agentId, issueId: originIssueId });
    });

    it("stays quiet while open or running, then wakes when effect completion commits", async () => {
      const row = await createCommentDecision();
      await db.update(decisions).set({ status: "decided", executionStatus: "running", chosenOptionId: "yes",
        decidedByUserId, metadata: { continuationPending: true } }).where(eq(decisions.id, row.id));
      await start(); await quiet(); expect(wake).not.toHaveBeenCalled();
      await workerService().decide({ id: row.id, optionId: "yes", decidedByUserId, userActor: boardActor() });
      await quiet(); await delivered(row.id); expect(wake).toHaveBeenCalledTimes(1);
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(1);
    });

    it("coalesces simultaneous foreground replay and worker delivery without replaying effects", async () => {
      const row = await createCommentDecision();
      await start();
      await Promise.all(Array.from({ length: 3 }, () => workerService().decide({
        id: row.id, optionId: "yes", decidedByUserId, userActor: boardActor(),
      }).catch(error => { if (error.message !== "decision_already_resolved") throw error; })));
      await quiet(); await delivered(row.id); expect(wake).toHaveBeenCalledTimes(1);
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(1);
    });

    it("shares an in-flight wake with a dedicated child pool and rereads after completion", async () => {
      const row = await createCommentDecision(); await markReady(row.id);
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      wake.mockImplementationOnce(async () => gate);
      const first = decisionContinuationService(db, wake).deliver(row.id);
      const childWake = vi.fn(async () => {});
      let child: Promise<void>;
      try {
        await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
        child = withDedicatedDbConnection(db, async connection => {
          const attempt = decisionContinuationService(connection, childWake).deliver(row.id);
          expect(attempt).toBe(first);
          await attempt;
        });
        await vi.advanceTimersByTimeAsync(100);
      } finally { release(); }
      await first; await child!;
      await decisionContinuationService(db, childWake).deliver(row.id);
      expect(childWake).not.toHaveBeenCalled(); await delivered(row.id);
    });

    it("reconstructs pending delivery at restart without replaying decision effects", async () => {
      const row = await createCommentDecision();
      wake.mockRejectedValueOnce(new Error("wake unavailable"));
      await expect(workerService().decide({ id: row.id, optionId: "yes", decidedByUserId, userActor: boardActor() })).rejects.toThrow("wake unavailable");
      await pending(row.id); await start(); await quiet(); await delivered(row.id);
      expect(wake).toHaveBeenCalledTimes(2);
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(1);
    });

    it("retries a failed acknowledgement with the existing at-least-once wake contract", async () => {
      const row = await createCommentDecision(); await start();
      await db.execute(sql`create function decision_ack_fail() returns trigger language plpgsql as $$ begin
        if NEW.metadata ->> 'continuationPending' = 'false' then raise exception 'ack unavailable'; end if;
        return NEW; end $$`);
      await db.execute(sql`create trigger decision_ack_fail before update on decisions for each row execute function decision_ack_fail()`);
      await expect(workerService().cancel(row.id, { actorType: "agent", actorId: agentId })).rejects.toMatchObject({ cause: { message: "ack unavailable" } });
      await pending(row.id);
      await vi.advanceTimersByTimeAsync(60_000);
      await db.execute(sql`drop trigger decision_ack_fail on decisions`);
      await quiet(); await delivered(row.id);
      expect(wake.mock.calls.length).toBeGreaterThan(1);
      for (const error of errors) expect(error).toMatchObject({ cause: { message: "ack unavailable" } });
      errors.length = 0;
    });

    it("waits for an outer transaction, ignores rollback, and recovers the committed write", async () => {
      const row = await createCommentDecision(); await start(); await quiet();
      await expect(db.transaction(async tx => {
        await markReady(row.id, tx as unknown as typeof db);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(wake).not.toHaveBeenCalled(); throw new Error("rollback");
      })).rejects.toThrow("rollback");
      await quiet(); expect((await service().get(row.id))?.status).toBe("open");
      await db.transaction(async tx => {
        await markReady(row.id, tx as unknown as typeof db);
        await vi.advanceTimersByTimeAsync(60_000); expect(wake).not.toHaveBeenCalled();
      });
      await quiet(); await delivered(row.id); expect(wake).toHaveBeenCalledTimes(1);
    });

    it("retains a first write during drain without scanning and delivers after resume", async () => {
      const row = await createCommentDecision(); await start(); await quiet(); draining = true;
      await markReady(row.id);
      const reads = vi.spyOn(db, "select");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reads).not.toHaveBeenCalled(); reads.mockRestore(); expect(wake).not.toHaveBeenCalled();
      draining = false; await quiet(); await delivered(row.id); expect(wake).toHaveBeenCalledTimes(1);
    });

    it("retains a failed wake through drain and resumes its retry", async () => {
      const row = await createCommentDecision(); await start();
      wake.mockImplementationOnce(async () => { draining = true; throw new Error("wake unavailable"); });
      await markReady(row.id);
      await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(30_000); expect(errors).toHaveLength(1); });
      await pending(row.id);
      const reads = vi.spyOn(db, "select"); await vi.advanceTimersByTimeAsync(60_000);
      expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
      draining = false; errors.length = 0; await quiet(); await delivered(row.id); expect(wake).toHaveBeenCalledTimes(2);
    });

    it("preserves changes arriving during delivery and stops after shutdown", async () => {
      const firstRow = await createCommentDecision(), secondRow = await createCommentDecision();
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      wake.mockImplementationOnce(async () => { await markReady(secondRow.id); await gate; });
      await markReady(firstRow.id);
      const starting = start();
      try { await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1)); }
      finally { release(); }
      await starting; await quiet(); await delivered(firstRow.id); await delivered(secondRow.id);
      expect(wake).toHaveBeenCalledTimes(2);
      await coordinator!.stop(); coordinator = undefined;
      await vi.advanceTimersByTimeAsync(60_000); expect(wake).toHaveBeenCalledTimes(2);
    });

    it("awaits an admitted wake before completing shutdown", async () => {
      const row = await createCommentDecision(), other = await createCommentDecision();
      await markReady(row.id); await markReady(other.id);
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      wake.mockImplementationOnce(async () => gate);
      const starting = start();
      let stopped = false;
      let stopping: Promise<void>;
      try {
        await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
        stopping = coordinator!.stop().then(() => { stopped = true; });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(stopped).toBe(false);
      } finally { release(); }
      await starting; await stopping!; coordinator = undefined;
      expect(wake).toHaveBeenCalledTimes(1);
      const sentId = wake.mock.calls[0][0].decisionId as string;
      await delivered(sentId); await pending(sentId === row.id ? other.id : row.id); expect(stopped).toBe(true);
    });

    it("pages past a failed first candidate and preserves its retry", async () => {
      const seed = await createCommentDecision();
      await db.delete(decisionTargetIssues).where(eq(decisionTargetIssues.decisionId, seed.id));
      await db.delete(decisions).where(eq(decisions.id, seed.id));
      const ids = Array.from({ length: 101 }, (_, i) => `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
      await db.insert(decisions).values(ids.map(id => ({ ...seed, id, status: "cancelled", metadata: { continuationPending: true } })));
      wake.mockImplementation(async input => { if (input.decisionId === ids[0]) throw new Error("first unavailable"); });
      const recovery = workerService();
      await expect(recovery.sweepContinuations()).rejects.toThrow("first unavailable");
      expect(wake).toHaveBeenCalledTimes(100); await pending(ids.at(-1)!);
      expect(await recovery.sweepContinuations()).toEqual({ retry: true });
      expect(wake).toHaveBeenCalledTimes(101); await delivered(ids.at(-1)!); await pending(ids[0]);
      wake.mockImplementation(async () => {});
      await start(); await quiet(); await delivered(ids[0]); expect(wake).toHaveBeenCalledTimes(102);
    });
  });

});
