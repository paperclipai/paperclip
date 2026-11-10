import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { agentWakeupRequests, issues } from "@paperclipai/db";
import {
  adoptableAsQueuedCommentsOnly,
  cancelStaleParkedWake,
  parkedExecutionWakePayloadSql,
  settleSavedWakesAfterDelivery,
} from "./parked-execution-wakes.js";
import { enrichWakeContextSnapshot, mergeCoalescedContextSnapshot } from "./heartbeat/run-preparation.js";
import { withQueuedCommentIdsInWakePayload } from "./issue-queued-comment-queue.js";
import {
  decideExecutionWakeFreshness,
  decideParkedStageScan,
  EXECUTION_STAGE_WAKE_REASONS,
  INTERACTION_CONTINUATION_CONTEXT_KEYS,
  settleWakeAfterDeliveredComments,
  withoutStaleStageOnResumedReceipt,
} from "../modules/wake-queue/index.js";

describe("parkedExecutionWakePayloadSql", () => {
  const query = new PgDialect().sqlToQuery(parkedExecutionWakePayloadSql);

  it("selects execution-stage wakes by reason, and no system continuations", () => {
    expect(query.sql).not.toContain(`"agent_wakeup_requests"."source"`);
    expect(query.sql).not.toContain(`"agent_wakeup_requests"."requested_by_actor_type"`);
    expect(query.params.slice(0, 3)).toEqual([
      "execution_review_requested",
      "execution_approval_requested",
      "execution_changes_requested",
    ]);
    expect(query.params).not.toContain("run_liveness_continuation");
    expect(query.params).not.toContain("issue_continuation_needed");
  });

  it("selects a stage wake only when it saved the stage it was for", () => {
    expect(query.sql).toMatch(/coalesce\("agent_wakeup_requests"."payload"#>>'\{executionStage,stageId\}', "agent_wakeup_requests"."payload"#>>'\{_paperclipWakeContext,executionStage,stageId\}'\) is not null/);
  });

  it("excludes wakes that carry other work", () => {
    expect(query.sql).toContain(`#>'{_paperclipWakeContext,wakeCommentIds}' end), 0) = 0`);
    expect(query.sql).toContain(`->>'mutation' is distinct from 'interaction'`);
    expect(query.sql).toContain(`#>>'{_paperclipWakeContext,resumeIntent}' is distinct from 'true'`);
    expect(query.sql).toContain("not jsonb_exists_any(");
    expect(query.params).toEqual(expect.arrayContaining(["interactionId", "continuationPolicy", "itemVerdicts"]));
  });
});

describe("cancelStaleParkedWake", () => {
  it("writes only while the wake and its issue are at the versions the scan read", async () => {
    const captured: { set?: Record<string, unknown>; where?: unknown } = {};
    const db = {
      update: (table: unknown) => {
        expect(table).toBe(agentWakeupRequests);
        return {
          set: (values: Record<string, unknown>) => {
            captured.set = values;
            return { where: (where: unknown) => { captured.where = where; return { returning: async () => [{ id: "wake-1" }] }; } };
          },
        };
      },
    };
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(await cancelStaleParkedWake(db as never, { wakeId: "wake-1", wakeVersion: "101", issueId: "issue-1", issueVersion: "202", now })).toBe(true);
    expect(captured.set).toMatchObject({ status: "cancelled", error: "The stage or assignment this deferred wake was for has moved on" });
    const where = new PgDialect().sqlToQuery(captured.where as never);
    expect(where.sql).toContain(`"agent_wakeup_requests"."status" = $`);
    expect(where.sql).toContain(`"agent_wakeup_requests".xmin::text = $`);
    expect(where.sql).toContain(`"issues".xmin::text = $`);
    expect(where.params).toEqual(expect.arrayContaining(["wake-1", "deferred_issue_execution", "101", "issue-1", "202"]));
  });
});

// ---------------------------------------------------------------------------
// Stranded-queue scan and pause-lifted pass, without a database. Merged rows
// are built with the real context merge the admission path uses; the scan's
// selection is a mirror of the SQL in heartbeat/queue.ts (join, where, order
// by updatedAt, limit 50), not the SQL itself.
// ---------------------------------------------------------------------------

const reviewer = "reviewer-agent";
const stageOf = (stageId: string) => ({ stageId, stageType: "review", wakeRole: "reviewer" });
const reviewIssue = (currentStageId: string) => ({
  status: "in_review",
  assigneeAgentId: reviewer,
  executionState: { status: "pending", currentStageId, currentStageType: "review",
    currentParticipant: { type: "agent", agentId: reviewer }, returnAssignee: { type: "agent", agentId: "executor-agent" } },
});

type Arrival = { payload: Record<string, unknown>; context: Record<string, unknown> };
const stageArrival = (stageId: string): Arrival => ({
  payload: { issueId: "issue-1", executionStage: stageOf(stageId) },
  context: { issueId: "issue-1", wakeReason: "execution_review_requested", source: "issue.execution_stage", executionStage: stageOf(stageId) },
});
const livenessArrival = (): Arrival => ({
  payload: { issueId: "issue-1", sourceRunId: "run-0", livenessState: "plan_only", continuationAttempt: 1 },
  context: { issueId: "issue-1", wakeReason: "run_liveness_continuation", livenessContinuationAttempt: 1,
    livenessContinuationSourceRunId: "run-0", livenessContinuationInstruction: "Take the next step." },
});
const commentArrival = (commentId = "c1"): Arrival => ({
  payload: { issueId: "issue-1", commentId },
  context: { issueId: "issue-1", wakeReason: "issue_commented", source: "issue.comment", commentId, wakeCommentIds: [commentId] },
});

/**
 * The payload admission stores when each arrival in turn merges into the
 * deferred wake the earlier ones left (use-cases.ts, merge branch).
 */
function merged(first: Arrival, ...later: Arrival[]): Record<string, unknown> {
  const result = later.reduce<Arrival>((existing, next) => ({
    payload: { ...existing.payload, ...next.payload, issueId: "issue-1" },
    context: mergeCoalescedContextSnapshot(existing.context, next.context, { preserveExistingInteractionContinuation: true }),
  }), first);
  return { ...result.payload, _paperclipWakeContext: result.context };
}
const unmerged = (arrival: Arrival) => ({ ...arrival.payload, _paperclipWakeContext: arrival.context });

const seedOf = (payload: Record<string, unknown>) => (payload._paperclipWakeContext ?? {}) as Record<string, unknown>;
const commentIdsOf = (payload: Record<string, unknown>) => {
  const ids = seedOf(payload).wakeCommentIds;
  return Array.isArray(ids) ? ids : [];
};

/** Mirror of `parkedExecutionWakePayloadSql`. */
function parkedStagePredicate(payload: Record<string, unknown>) {
  const seed = seedOf(payload);
  const stageId = (payload.executionStage as { stageId?: string } | undefined)?.stageId ??
    (seed.executionStage as { stageId?: string } | undefined)?.stageId;
  return (EXECUTION_STAGE_WAKE_REASONS as readonly string[]).includes(String(seed.wakeReason)) && stageId != null &&
    commentIdsOf(payload).length === 0 && payload.mutation !== "interaction" && String(seed.resumeIntent) !== "true" &&
    !INTERACTION_CONTINUATION_CONTEXT_KEYS.some(key => key in seed);
}

type Row = { id: string; agentId: string; status: string; updatedAt: number; payload: Record<string, unknown> };

/**
 * One stranded-queue pass, as heartbeat/queue.ts runs it: select (mirror),
 * decide with the real `decideParkedStageScan`, write, bump `updatedAt` for a
 * wake it goes on with. Returns the ids it went on with.
 */
function scanPass(rows: Row[], issue: ReturnType<typeof reviewIssue>, now: number) {
  const selected = rows
    .filter(row => row.status === "deferred_issue_execution")
    .filter(row => issue.assigneeAgentId === row.agentId || seedOf(row.payload).wakeReason === "issue_comment_mentioned" ||
      parkedStagePredicate(row.payload))
    .filter(row => commentIdsOf(row.payload).length > 0 || row.payload.mutation === "interaction" || parkedStagePredicate(row.payload))
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(0, 50);
  const wentOn: string[] = [];
  for (const row of selected) {
    const promotesOtherWork = commentIdsOf(row.payload).length > 0;
    const action = decideParkedStageScan({ wake: row, issue }, promotesOtherWork);
    if (action.kind === "cancel") { row.status = "cancelled"; continue; }
    if (action.kind === "store") { row.payload = action.payload; row.updatedAt = now; continue; }
    const current = decideExecutionWakeFreshness({ wake: row, issue }) === "current";
    if (!current && !promotesOtherWork) continue;
    row.updatedAt = now;
    wentOn.push(row.id);
  }
  return wentOn;
}

describe("stranded-queue scan: a stale stage merged with a run liveness continuation", () => {
  const issue = reviewIssue("stage-current");

  it.each([
    ["liveness first, stage second", () => merged(livenessArrival(), stageArrival("stage-old"))],
    ["stage first, liveness second", () => merged(stageArrival("stage-old"), livenessArrival())],
  ])("is stored without the stale stage and under the continuation reason (%s)", (_order, build) => {
    const payload = build();
    const action = decideParkedStageScan({ wake: { agentId: reviewer, payload }, issue }, false);
    if (action.kind !== "store") throw new Error(`expected store, got ${action.kind}`);
    expect(action.payload).not.toHaveProperty("executionStage");
    expect(seedOf(action.payload)).not.toHaveProperty("executionStage");
    expect(seedOf(action.payload)).toMatchObject({ wakeReason: "run_liveness_continuation", livenessContinuationSourceRunId: "run-0" });
    expect(action.payload).toMatchObject({ sourceRunId: "run-0", livenessState: "plan_only" });
    expect(parkedStagePredicate(action.payload)).toBe(false);
  });

  it("leaves a stale stage to the drain when the scan promotes other work on the wake", () => {
    const payload = merged(stageArrival("stage-old"), livenessArrival(), commentArrival());
    expect(decideParkedStageScan({ wake: { agentId: reviewer, payload }, issue }, true)).toEqual({ kind: "none" });
  });

  it("cancels a wake that carries only a stale stage, and goes on with a current one", () => {
    expect(decideParkedStageScan({ wake: { agentId: reviewer, payload: unmerged(stageArrival("stage-old")) }, issue }, false))
      .toEqual({ kind: "cancel" });
    expect(decideParkedStageScan({ wake: { agentId: reviewer, payload: unmerged(stageArrival("stage-current")) }, issue }, false))
      .toEqual({ kind: "none" });
    expect(decideParkedStageScan({ wake: { agentId: reviewer, payload: merged(livenessArrival(), stageArrival("stage-current")) }, issue }, false))
      .toEqual({ kind: "none" });
  });

  it("reaches a current stage behind 60 stale mixed wakes in consecutive passes, without replaying or dropping work", () => {
    const rows: Row[] = [];
    // Liveness first, stage merged last: the row shows the stage reason, so
    // the scan selects it (60 > one page of 50).
    for (let i = 0; i < 60; i += 1) {
      rows.push({ id: `mixed-${i}`, agentId: reviewer, status: "deferred_issue_execution", updatedAt: i,
        payload: merged(livenessArrival(), stageArrival("stage-old")) });
    }
    // Stage first, liveness merged last: shows the continuation reason, never
    // selected (as on master), left untouched.
    const untouched = merged(stageArrival("stage-old"), livenessArrival());
    rows.push({ id: "liveness-last", agentId: reviewer, status: "deferred_issue_execution", updatedAt: 59.5, payload: untouched });
    for (let i = 0; i < 5; i += 1) {
      rows.push({ id: `stale-${i}`, agentId: reviewer, status: "deferred_issue_execution", updatedAt: 60 + i, payload: unmerged(stageArrival("stage-old")) });
    }
    rows.push({ id: "current", agentId: reviewer, status: "deferred_issue_execution", updatedAt: 100, payload: unmerged(stageArrival("stage-current")) });

    const first = scanPass(rows, issue, 1_000);
    expect(first).toEqual([]);
    const second = scanPass(rows, issue, 2_000);
    expect(second).toEqual(["current"]);

    const mixed = rows.filter(row => row.id.startsWith("mixed-"));
    expect(mixed.every(row => row.status === "deferred_issue_execution")).toBe(true);
    expect(mixed.every(row => !("executionStage" in row.payload) && !("executionStage" in seedOf(row.payload)))).toBe(true);
    expect(mixed.every(row => seedOf(row.payload).wakeReason === "run_liveness_continuation" &&
      seedOf(row.payload).livenessContinuationSourceRunId === "run-0")).toBe(true);
    expect(rows.filter(row => row.id.startsWith("stale-")).every(row => row.status === "cancelled")).toBe(true);
    // Stored once: no later pass selects them again.
    const before = mixed.map(row => row.updatedAt);
    scanPass(rows, issue, 3_000);
    expect(mixed.map(row => row.updatedAt)).toEqual(before);
    const lastRow = rows.find(row => row.id === "liveness-last")!;
    expect(lastRow).toMatchObject({ status: "deferred_issue_execution", updatedAt: 59.5, payload: untouched });
  });
});

describe("pause-lifted pass: comments a completed run already received", () => {
  const issueCurrent = reviewIssue("stage-current");
  const settle = (payload: Record<string, unknown>, remaining: string[], issue = issueCurrent) =>
    settleWakeAfterDeliveredComments({ agentId: reviewer, rowReason: "issue_execution_deferred",
      payload: withQueuedCommentIdsInWakePayload(payload, remaining) }, issue);

  it("cancels a comment-only wake when all comments were delivered, and keeps the rest otherwise (as before)", () => {
    const payload = merged(commentArrival("c1"), commentArrival("c2"));
    expect(settle(payload, [])).toEqual({ judgedStage: false, kind: "cancel_delivered" });
    const kept = settle(payload, ["c2"]);
    expect(kept).toMatchObject({ judgedStage: false, kind: "store" });
    expect(kept.kind === "store" && kept.payload).toEqual(withQueuedCommentIdsInWakePayload(payload, ["c2"]));
  });

  it.each([
    ["stage first, comment second", () => merged(stageArrival("stage-current"), commentArrival())],
    ["comment first, stage second", () => merged(commentArrival(), stageArrival("stage-current"))],
  ])("keeps a current stage when its merged comment was delivered (%s)", (_order, build) => {
    const settled = settle(build(), []);
    if (settled.kind !== "store") throw new Error(`expected store, got ${settled.kind}`);
    expect(settled.judgedStage).toBe(true);
    expect(seedOf(settled.payload)).toMatchObject({ wakeReason: "execution_review_requested", executionStage: stageOf("stage-current") });
    expect(commentIdsOf(settled.payload)).toEqual([]);
    // Stored under the stage reason, so the stranded-queue scan selects it.
    expect(parkedStagePredicate(settled.payload)).toBe(true);
  });

  it.each([
    ["stage first, comment second", () => merged(stageArrival("stage-old"), commentArrival())],
    ["comment first, stage second", () => merged(commentArrival(), stageArrival("stage-old"))],
  ])("cancels a stale stage whose merged comment was delivered (%s)", (_order, build) => {
    const settled = settle(build(), []);
    expect(settled.judgedStage).toBe(true);
    expect(["cancel_stale", "cancel_delivered"]).toContain(settled.kind);
  });

  it.each([
    ["stage, liveness, then comment", () => merged(stageArrival("stage-old"), livenessArrival(), commentArrival())],
    ["comment, liveness, then stage", () => merged(commentArrival(), livenessArrival(), stageArrival("stage-old"))],
  ])("keeps a carried liveness continuation and drops the stale stage (%s)", (_order, build) => {
    const settled = settle(build(), []);
    if (settled.kind !== "store") throw new Error(`expected store, got ${settled.kind}`);
    expect(settled.payload).not.toHaveProperty("executionStage");
    expect(seedOf(settled.payload)).not.toHaveProperty("executionStage");
    expect(seedOf(settled.payload)).toMatchObject({ wakeReason: "run_liveness_continuation", livenessContinuationSourceRunId: "run-0" });
  });

  it("drops a stale stage and keeps a comment that was not delivered", () => {
    const settled = settle(merged(stageArrival("stage-old"), commentArrival("c1"), commentArrival("c2")), ["c2"]);
    if (settled.kind !== "store") throw new Error(`expected store, got ${settled.kind}`);
    expect(seedOf(settled.payload)).not.toHaveProperty("executionStage");
    expect(seedOf(settled.payload)).toMatchObject({ wakeReason: "issue_commented" });
    expect(commentIdsOf(settled.payload)).toEqual(["c2"]);
  });

  it("keeps a liveness continuation with no stage under its own reason, unjudged", () => {
    const settled = settle(merged(livenessArrival(), commentArrival()), [], { ...issueCurrent, status: "blocked" });
    if (settled.kind !== "store") throw new Error(`expected store, got ${settled.kind}`);
    expect(settled.judgedStage).toBe(false);
    expect(seedOf(settled.payload)).toMatchObject({ wakeReason: "run_liveness_continuation" });
  });
});

// ---------------------------------------------------------------------------
// Pause-lifted entry. The pass settles the agent's saved wakes on the task
// (settleSavedWakesAfterDelivery, run here against a fake db), then resumes
// one through admission, which judges its saved stage under the issue lock
// (withoutStaleStageOnResumedReceipt) and adopts other saved comment wakes
// by ID only if they carry nothing else (adoptableAsQueuedCommentsOnly).
// ---------------------------------------------------------------------------

/** What admission builds from a saved receipt the pause-lifted pass resumes. */
function resumedReceipt(stored: Record<string, unknown>) {
  const { _paperclipWakeContext: seed, ...payload } = stored;
  const { contextSnapshot } = enrichWakeContextSnapshot({ contextSnapshot: { ...(seed as Record<string, unknown>) },
    reason: "issue_commented", source: "on_demand", triggerDetail: null, payload });
  return { agentId: reviewer, payload: { ...payload, _paperclipWakeContext: { ...contextSnapshot } }, contextSnapshot };
}

describe("pause-lifted entry: the resumed receipt's saved stage", () => {
  const issue = reviewIssue("stage-current");
  const orders = (stageId: string) => [
    ["stage first, comment second", () => merged(stageArrival(stageId), commentArrival("c1"))],
    ["comment first, stage second", () => merged(commentArrival("c1"), stageArrival(stageId))],
  ] as const;

  it.each(orders("stage-old"))("delivers an undelivered comment without a stale stage (%s)", (_order, build) => {
    const receipt = resumedReceipt(build());
    expect(receipt.contextSnapshot).toHaveProperty("executionStage");
    const resumed = withoutStaleStageOnResumedReceipt(receipt, issue);
    expect(resumed.strippedStage).toBe(true);
    for (const context of [resumed.contextSnapshot, seedOf(resumed.payload)]) {
      expect(context).not.toHaveProperty("executionStage");
      expect(context).toMatchObject({ wakeReason: "issue_commented", wakeCommentIds: ["c1"] });
      expect(context.source).not.toBe("issue.execution_stage");
    }
    expect(resumed.payload).not.toHaveProperty("executionStage");
    expect(resumed.payload).toMatchObject({ commentId: "c1" });
  });

  it.each(orders("stage-current"))("keeps a current stage with the comment (%s)", (_order, build) => {
    const receipt = resumedReceipt(build());
    const resumed = withoutStaleStageOnResumedReceipt(receipt, issue);
    expect(resumed).toEqual({ payload: receipt.payload, contextSnapshot: receipt.contextSnapshot, strippedStage: false });
    expect(resumed.contextSnapshot).toMatchObject({ executionStage: stageOf("stage-current"), wakeCommentIds: ["c1"] });
  });

  it("keeps a carried liveness continuation when it drops a stale stage", () => {
    const resumed = withoutStaleStageOnResumedReceipt(resumedReceipt(merged(stageArrival("stage-old"), livenessArrival(), commentArrival("c1"))), issue);
    expect(resumed.contextSnapshot).not.toHaveProperty("executionStage");
    expect(resumed.contextSnapshot).toMatchObject({ livenessContinuationSourceRunId: "run-0", wakeCommentIds: ["c1"] });
  });

  it("leaves a receipt with no saved stage alone", () => {
    const receipt = resumedReceipt(merged(commentArrival("c1")));
    expect(withoutStaleStageOnResumedReceipt(receipt, issue).strippedStage).toBe(false);
  });
});

describe("pause-lifted entry: another saved wake adopted by comment ID", () => {
  const row = (payload: Record<string, unknown>) => ({ idempotencyKey: null, reason: "issue_commented", payload });

  it.each([
    ["current stage, then comment", () => merged(stageArrival("stage-current"), commentArrival("c2"))],
    ["comment, then current stage", () => merged(commentArrival("c2"), stageArrival("stage-current"))],
    ["stale stage, then comment", () => merged(stageArrival("stage-old"), commentArrival("c2"))],
    ["comment, then stale stage", () => merged(commentArrival("c2"), stageArrival("stage-old"))],
    ["liveness continuation, then comment", () => merged(livenessArrival(), commentArrival("c2"))],
    ["comment, then liveness continuation", () => merged(commentArrival("c2"), livenessArrival())],
  ])("stays deferred with its comments when it carries more than comments (%s)", (_order, build) => {
    expect(adoptableAsQueuedCommentsOnly(row(build()))).toBe(false);
  });

  it("adopts a wake that carries only comments, as before", () => {
    expect(adoptableAsQueuedCommentsOnly(row(merged(commentArrival("c2"), commentArrival("c3"))))).toBe(true);
    expect(adoptableAsQueuedCommentsOnly(row(unmerged(commentArrival("c2"))))).toBe(true);
    expect(adoptableAsQueuedCommentsOnly({ ...row(unmerged(commentArrival("c2"))), idempotencyKey: "chat-inbound:x" })).toBe(false);
  });
});

describe("pause-lifted entry: settling saved wakes against a concurrent merge", () => {
  type SavedRow = { id: string; agentId: string; reason: string; payload: Record<string, unknown> };
  /** A db that returns the rows as read, and applies an update only while the row is at the version read. */
  function fakeDb(rows: SavedRow[], issueFacts: ReturnType<typeof reviewIssue>, changedAfterRead: Set<string>) {
    const writes: Array<{ id: string; set: Record<string, unknown>; where: { sql: string; params: unknown[] }; applied: boolean }> = [];
    const db = {
      select: () => ({ from: (table: unknown) => ({ where: async () => table === issues
        ? [{ ...issueFacts, version: "issue-v1" }]
        : rows.map(receipt => ({ receipt, version: `${receipt.id}-v1` })) }) }),
      update: () => ({ set: (set: Record<string, unknown>) => ({ where: (where: unknown) => ({ returning: async () => {
        const query = new PgDialect().sqlToQuery(where as never);
        const id = String(query.params[0]);
        const applied = !changedAfterRead.has(id);
        writes.push({ id, set, where: query, applied });
        return applied ? [{ id }] : [];
      } }) }) }),
    };
    return { db: db as never, writes };
  }
  const deliveredAll = async (ids: string[]) => new Set(ids);

  it("does not cancel a wake read as comment-only once a stage has merged into it", async () => {
    // Read: only comment c1, which a completed run received. After the read
    // a current stage merges into the row, which changes its version.
    const rows = [{ id: "wake-a", agentId: reviewer, reason: "issue_commented", payload: unmerged(commentArrival("c1")) }];
    const { db, writes } = fakeDb(rows, reviewIssue("stage-current"), new Set(["wake-a"]));
    const settled = await settleSavedWakesAfterDelivery(db, { companyId: "co", agentId: reviewer, issueId: "issue-1", deliveredCommentIds: deliveredAll });
    expect(settled).toBe(false);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ id: "wake-a", applied: false, set: { status: "cancelled" } });
    expect(writes[0].where.sql).toContain(`"agent_wakeup_requests".xmin::text = $`);
    expect(writes[0].where.sql).toContain(`"issues".xmin::text = $`);
    expect(writes[0].where.params).toEqual(expect.arrayContaining(["wake-a", "wake-a-v1", "issue-1", "issue-v1"]));
  });

  it("guards every write, judged or not, and reports success when none was skipped", async () => {
    const rows = [
      { id: "comment-only", agentId: reviewer, reason: "issue_commented", payload: merged(commentArrival("c1"), commentArrival("c2")) },
      { id: "current-stage", agentId: reviewer, reason: "issue_commented", payload: merged(stageArrival("stage-current"), commentArrival("c3")) },
      { id: "stale-stage", agentId: reviewer, reason: "issue_commented", payload: merged(stageArrival("stage-old"), commentArrival("c4")) },
      { id: "untouched", agentId: reviewer, reason: "issue_commented", payload: unmerged(commentArrival("c9")) },
    ];
    const { db, writes } = fakeDb(rows, reviewIssue("stage-current"), new Set());
    const delivered = async (ids: string[]) => new Set(ids.filter(id => id !== "c2" && id !== "c9"));
    expect(await settleSavedWakesAfterDelivery(db, { companyId: "co", agentId: reviewer, issueId: "issue-1", deliveredCommentIds: delivered })).toBe(true);
    expect(writes.map(write => write.id)).toEqual(["comment-only", "current-stage", "stale-stage"]);
    for (const write of writes) {
      expect(write.where.sql).toContain(`"agent_wakeup_requests".xmin::text = $`);
      expect(write.where.sql).toContain(`"issues".xmin::text = $`);
    }
    expect(seedOf(writes[0].set.payload as Record<string, unknown>)).toMatchObject({ wakeCommentIds: ["c2"] });
    expect(seedOf(writes[1].set.payload as Record<string, unknown>)).toMatchObject({ executionStage: stageOf("stage-current"),
      wakeReason: "execution_review_requested" });
    expect(writes[2].set).toMatchObject({ status: "cancelled" });
  });
});
