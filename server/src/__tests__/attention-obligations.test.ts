import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  approvals,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueApprovals,
  issues,
} from "@paperclipai/db";
import type { AttentionAudience, AttentionItem, AttentionSourceKind } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  assignAttentionObligations,
  attentionService,
  type AttentionObligationHint,
} from "../services/attention.js";
import { inboxDismissalService } from "../services/inbox-dismissals.js";
import { ROUTABLE_BLOCKED_ROLLOUT_AT } from "../services/routable-blocked.js";

const SCOTT = "scott";
const DOTTA = "dotta";
const COMPANY: AttentionAudience = { kind: "company", userId: null, reason: "none" };
const POOL: AttentionAudience = { kind: "pool", userId: null, reason: "none" };
const forUser = (userId: string, reason: AttentionAudience["reason"] = "instigator"): AttentionAudience =>
  ({ kind: "user", userId, reason });

// PAP-749 task 2d: the pure obligation rules (plan §2, Rule 11).
describe("one card for each obligation (PAP-749 task 2d)", () => {
  function card(
    sourceKind: AttentionSourceKind,
    dedupKey: string,
    input: { audience?: AttentionAudience; required?: boolean; activityAt?: string } = {},
  ): AttentionItem {
    return {
      id: `${sourceKind}:${dedupKey}`,
      sourceKind,
      dedupKey,
      audience: input.audience ?? forUser(SCOTT),
      required: input.required ?? false,
      activityAt: input.activityAt ?? "2026-10-30T10:00:00.000Z",
      severity: "medium",
      obligationKey: null,
      obligationLeadId: null,
    } as AttentionItem;
  }
  const hints = (entries: Array<[AttentionItem, AttentionObligationHint]>) =>
    new Map(entries.map(([item, hint]) => [item.dedupKey, hint]));

  it("joins a pending approval with the in-review state of its task, led by the approval", () => {
    const approval = card("approval", "approval:a1", { audience: forUser(DOTTA, "requester"), required: true });
    const review = card("review", "review:i1", { audience: forUser(SCOTT, "assignee"), activityAt: "2026-10-30T11:00:00.000Z" });
    assignAttentionObligations([review, approval], hints([
      [approval, { key: "approval:a1", anchor: true }],
      [review, { key: "approval:a1", anchor: false }],
    ]));
    for (const member of [approval, review]) {
      expect(member.obligationKey).toBe("approval:a1");
      expect(member.obligationLeadId).toBe(approval.id);
      // One placement: the approval's person, so the obligation shows once.
      expect(member.audience).toEqual(forUser(DOTTA, "requester"));
    }
  });

  it("joins a blocked task with the failed run that caused it, led by the run, placed with the task's person", () => {
    const blocked = card("blocker_attention", "blocked-owner:t1:2026-10-30", { audience: forUser(SCOTT) });
    const terminal = card("blocker_attention", "blocker:t1", { audience: forUser(SCOTT) });
    const run = card("failed_run", "run:r1", { audience: COMPANY, activityAt: "2026-10-30T09:00:00.000Z" });
    assignAttentionObligations([blocked, terminal, run], hints([
      [blocked, { key: "blocked:t1", anchor: true }],
      [terminal, { key: "blocked:t1", anchor: true }],
      [run, { key: "blocked:t1", anchor: false }],
    ]));
    for (const member of [blocked, terminal, run]) {
      expect(member.obligationKey).toBe("blocked:t1");
      // The run carries the one action (Retry); the blocked task is the effect.
      expect(member.obligationLeadId).toBe(run.id);
      expect(member.audience).toEqual(forUser(SCOTT));
    }
  });

  it("keeps a blocked obligation in Company when no person owns the blocked work", () => {
    const blocked = card("blocker_attention", "blocker:t2", { audience: POOL });
    const run = card("failed_run", "run:r2", { audience: COMPANY });
    assignAttentionObligations([blocked, run], hints([
      [blocked, { key: "blocked:t2", anchor: true }],
      [run, { key: "blocked:t2", anchor: false }],
    ]));
    expect(run.obligationLeadId).toBe(run.id);
    expect(blocked.audience).toEqual(COMPANY);
  });

  it("leaves a required lead where escalation put it", () => {
    const approval = card("approval", "approval:a3", { audience: COMPANY, required: true });
    const review = card("review", "review:i3", { audience: forUser(SCOTT, "assignee") });
    assignAttentionObligations([approval, review], hints([
      [approval, { key: "approval:a3", anchor: true }],
      [review, { key: "approval:a3", anchor: false }],
    ]));
    // "Waiting 30+ days" stays in Company; a review does not pull it back.
    expect(review.audience).toEqual(COMPANY);
  });

  it("leads a budget hard stop over its override approval and keeps the stop's placement (PAP-768)", () => {
    const owned = { kind: "user", userId: SCOTT, reason: "budget_owner", alsoInCompany: true } as AttentionAudience;
    const stop = card("budget_alert", "budget:p1:2026-11-01:hard", { audience: owned });
    const approval = card("approval", "approval:b1", { audience: POOL, required: true });
    assignAttentionObligations([approval, stop], hints([
      [approval, { key: "approval:b1", anchor: true }],
      [stop, { key: "approval:b1", anchor: true }],
    ]));
    for (const member of [stop, approval]) {
      expect(member.obligationKey).toBe("approval:b1");
      // Raise limit and Keep paused answer the approval, so the stop leads.
      expect(member.obligationLeadId).toBe(stop.id);
      // The approval leaves Unassigned and goes with the stop to its owner.
      expect(member.audience).toEqual(owned);
    }

    // Without a budget owner the stop stays in Company, even when the
    // approval alone would have gone to the default decision owner.
    const companyStop = card("budget_alert", "budget:p2:2026-11-01:hard", { audience: COMPANY });
    const ownersApproval = card("approval", "approval:b2", { audience: forUser(DOTTA, "escalation_owner"), required: true });
    assignAttentionObligations([companyStop, ownersApproval], hints([
      [companyStop, { key: "approval:b2", anchor: true }],
      [ownersApproval, { key: "approval:b2", anchor: true }],
    ]));
    expect(ownersApproval.obligationLeadId).toBe(companyStop.id);
    expect(ownersApproval.audience).toEqual(COMPANY);
    expect(companyStop.audience).toEqual(COMPANY);
  });

  it("forms no obligation without an anchor card, or for a card on its own", () => {
    const runA = card("failed_run", "run:ra", { audience: COMPANY });
    const runB = card("failed_run", "run:rb", { audience: COMPANY });
    const lonelyReview = card("review", "review:i4");
    const lonelyApproval = card("approval", "approval:a5", { required: true });
    assignAttentionObligations([runA, runB, lonelyReview, lonelyApproval], hints([
      [runA, { key: "blocked:t4", anchor: false }],
      [runB, { key: "blocked:t4", anchor: false }],
      [lonelyReview, { key: "approval:a4", anchor: false }],
      [lonelyApproval, { key: "approval:a5", anchor: true }],
    ]));
    for (const item of [runA, runB, lonelyReview, lonelyApproval]) {
      expect(item.obligationKey).toBeNull();
      expect(item.obligationLeadId).toBeNull();
    }
    expect(runA.audience).toEqual(COMPANY);
  });
});

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_ATTENTION_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalUrl ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres attention obligation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("attention obligations in the feed (PAP-749 task 2d)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    if (!externalUrl) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-attention-obligations-");
    db = createDb(externalUrl ?? tempDb!.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  let issueSeq = 0;
  async function insertIssue(companyId: string, input: Partial<typeof issues.$inferInsert> = {}) {
    const id = randomUUID();
    issueSeq += 1;
    await db.insert(issues).values({
      id,
      companyId,
      identifier: `OBL-${issueSeq}`,
      title: `Obligation issue ${issueSeq}`,
      status: "in_progress",
      priority: "medium",
      originKind: "manual",
      originFingerprint: `obl-${issueSeq}`,
      createdByUserId: SCOTT,
      ...input,
    });
    return id;
  }

  async function insertApproval(companyId: string, issueId: string, requestedByUserId = SCOTT) {
    const id = randomUUID();
    await db.insert(approvals).values({
      id, companyId, type: "request_board_approval", status: "pending",
      requestedByUserId, payload: { title: "Approve the in-review work" },
    });
    await db.insert(issueApprovals).values({ companyId, issueId, approvalId: id });
    return id;
  }

  async function insertExhaustedRun(companyId: string, agentId: string, issueId: string) {
    const id = randomUUID();
    const at = new Date(Date.now() - 60_000);
    await db.insert(heartbeatRuns).values({
      id, companyId, agentId, invocationSource: "automation", status: "failed",
      error: "adapter failed", errorCode: "adapter_failed", contextSnapshot: { issueId },
      createdAt: at, updatedAt: at, finishedAt: at,
    });
    await db.insert(heartbeatRunEvents).values({
      companyId, runId: id, agentId, seq: 1, eventType: "lifecycle",
      message: "Bounded retry exhausted after 3 scheduled attempts; no further automatic retry will be queued",
    });
    return id;
  }

  async function seed() {
    const companyId = randomUUID();
    const workerId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Obligation Co", issuePrefix: "OBL", requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: workerId, companyId, name: "Flaky Runner", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });

    // An approval and the in-review state of its task: one obligation.
    const reviewTask = await insertIssue(companyId, { status: "in_review", assigneeAgentId: workerId });
    const approvalId = await insertApproval(companyId, reviewTask);

    // A configured human review stage is an independent quality gate.
    const gatedTask = await insertIssue(companyId, {
      status: "in_review",
      assigneeAgentId: workerId,
      executionState: {
        status: "pending", currentStageId: null, currentStageIndex: null, currentStageType: "review",
        currentParticipant: { type: "user", userId: DOTTA }, returnAssignee: null, reviewRequest: null,
        completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null, monitor: null,
      },
    });
    const gatedApprovalId = await insertApproval(companyId, gatedTask);

    // A task blocked by its exhausted run, and a failed run that blocks nothing.
    const blockedTask = await insertIssue(companyId, {
      status: "blocked",
      assigneeAgentId: workerId,
      unblockDescriptor: { owner: "board", action: "Automatic retries exhausted. Retry or reassign the task." },
      blockedTransitionAt: new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 60_000),
    });
    const blockingRunId = await insertExhaustedRun(companyId, workerId, blockedTask);
    const otherTask = await insertIssue(companyId, { assigneeAgentId: workerId });
    const loneRunId = await insertExhaustedRun(companyId, workerId, otherTask);

    return { companyId, reviewTask, approvalId, gatedTask, gatedApprovalId, blockedTask, blockingRunId, loneRunId };
  }

  const list = (companyId: string, view?: "mine" | "company" | "archived" | "all") =>
    attentionService(db).list(companyId, { userId: SCOTT, view });
  const bySource = (items: AttentionItem[], sourceKind: AttentionSourceKind, subjectId: string) =>
    items.find((item) => item.sourceKind === sourceKind && item.subject.id === subjectId) ?? null;

  it("keeps every card, joins each obligation under one lead, and counts it once", async () => {
    const f = await seed();
    const feed = await list(f.companyId, "all");

    const approval = bySource(feed.items, "approval", f.approvalId)!;
    const review = bySource(feed.items, "review", f.reviewTask)!;
    expect(approval.obligationKey).toBe(`approval:${f.approvalId}`);
    expect(approval.obligationLeadId).toBe(approval.id);
    expect(review.obligationKey).toBe(`approval:${f.approvalId}`);
    expect(review.obligationLeadId).toBe(approval.id);
    expect(review.audience).toEqual(approval.audience);

    // Independent quality gate: the human review stage and its approval stay separate.
    const gatedReview = bySource(feed.items, "review", f.gatedTask)!;
    expect(gatedReview.obligationKey).toBeNull();
    expect(gatedReview.audience).toEqual(forUser(DOTTA, "reviewer"));
    expect(bySource(feed.items, "approval", f.gatedApprovalId)!.obligationKey).toBeNull();

    const run = bySource(feed.items, "failed_run", f.blockingRunId)!;
    const blockerCards = feed.items.filter((item) => item.sourceKind === "blocker_attention" && item.subject.id === f.blockedTask);
    expect(blockerCards.length).toBeGreaterThan(0);
    expect(run.obligationKey).toBe(`blocked:${f.blockedTask}`);
    expect(run.obligationLeadId).toBe(run.id);
    for (const blocker of blockerCards) {
      expect(blocker.obligationKey).toBe(`blocked:${f.blockedTask}`);
      expect(blocker.obligationLeadId).toBe(run.id);
    }
    // The failed run goes with the work it blocks, to the person who started it.
    expect(run.audience).toEqual(forUser(SCOTT));
    // A failed run that blocks nothing stays a Company alert of its own.
    const loneRun = bySource(feed.items, "failed_run", f.loneRunId)!;
    expect(loneRun.obligationKey).toBeNull();
    expect(loneRun.audience).toEqual(COMPANY);

    // Evidence sits right after its lead.
    const ids = feed.items.map((item) => item.id);
    expect(ids.indexOf(review.id)).toBe(ids.indexOf(approval.id) + 1);
    const runIndex = ids.indexOf(run.id);
    expect(ids.slice(runIndex + 1, runIndex + 1 + blockerCards.length).sort())
      .toEqual(blockerCards.map((item) => item.id).sort());

    // Scott's For you: the joined approval, the gated approval and the blocked
    // work, each counted once; the gated review is Dotta's.
    const mine = await list(f.companyId, "mine");
    expect(bySource(mine.items, "failed_run", f.blockingRunId)).not.toBeNull();
    expect(bySource(mine.items, "review", f.reviewTask)).not.toBeNull();
    expect(mine.viewCounts.mine).toBe(3);
    expect(mine.deskBadgeCount).toBe(3);
    const company = await list(f.companyId, "company");
    expect(company.items.map((item) => item.subject.id)).toEqual([f.loneRunId]);
    expect(company.viewCounts.company).toBe(1);
  }, 120_000);

  it("normalizes a personal hide of evidence to its obligation lead", async () => {
    const f = await seed();
    const before = await list(f.companyId, "mine");
    const review = bySource(before.items, "review", f.reviewTask)!;
    const approval = bySource(before.items, "approval", f.approvalId)!;
    const hidden = await attentionService(db).hideForUser(f.companyId, { sourceKind: "review", sourceId: f.reviewTask, userId: SCOTT,
      actor: { type: "board", userId: SCOTT }, mode: "archive", fingerprint: review.changeFingerprint });
    expect(hidden.itemKey).toBe(approval.dismissalKey);
    const mine = await list(f.companyId, "mine");
    expect(bySource(mine.items, "approval", f.approvalId)).toBeNull();
    expect(bySource(mine.items, "review", f.reviewTask)).toBeNull();
    const archived = await list(f.companyId, "archived");
    expect(archived.items.map(item => item.sourceKind).sort()).toEqual(["approval", "review"]);
  }, 120_000);

  it("hides and restores the evidence with its lead", async () => {
    const f = await seed();
    const before = await list(f.companyId, "mine");
    const approval = bySource(before.items, "approval", f.approvalId)!;
    const dismissals = inboxDismissalService(db);
    await dismissals.dismiss(f.companyId, SCOTT, approval.dismissalKey, new Date(), approval.changeFingerprint);

    const mine = await list(f.companyId, "mine");
    expect(bySource(mine.items, "approval", f.approvalId)).toBeNull();
    expect(bySource(mine.items, "review", f.reviewTask)).toBeNull();
    expect(mine.viewCounts).toMatchObject({ mine: 2, archived: 1 });

    const archived = await list(f.companyId, "archived");
    expect(archived.items.map((item) => item.sourceKind).sort()).toEqual(["approval", "review"]);

    await dismissals.restore(f.companyId, SCOTT, approval.dismissalKey);
    const restored = await list(f.companyId, "mine");
    expect(bySource(restored.items, "review", f.reviewTask)).not.toBeNull();
    expect(restored.viewCounts).toMatchObject({ mine: 3, archived: 0 });
  }, 120_000);

  it("splits the obligation again once the approval is answered", async () => {
    const f = await seed();
    // Dotta's task in review, waiting on an approval Scott requested.
    const dottaTask = await insertIssue(f.companyId, { status: "in_review", assigneeUserId: DOTTA });
    const approvalId = await insertApproval(f.companyId, dottaTask);
    let feed = await list(f.companyId, "all");
    const review = bySource(feed.items, "review", dottaTask)!;
    expect(review.obligationLeadId).toBe(`approval:approval:${approvalId}`);
    expect(review.audience).toEqual(forUser(SCOTT, "requester"));

    await db.update(approvals).set({ status: "approved" }).where(sql`${approvals.id} = ${approvalId}`);
    feed = await list(f.companyId, "all");
    expect(bySource(feed.items, "approval", approvalId)).toBeNull();
    // The assignee's own review card is back on its own, with its own person.
    const alone = bySource(feed.items, "review", dottaTask)!;
    expect(alone.obligationKey).toBeNull();
    expect(alone.obligationLeadId).toBeNull();
    expect(alone.audience).toEqual(forUser(DOTTA, "assignee"));
  }, 120_000);
});
