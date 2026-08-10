import { describe, expect, it } from "vitest";
import {
  BATCHABLE_ASSIGNMENT_WAKE_REASONS,
  BATCH_PICKUP_EXEMPT_WAKE_REASONS,
  buildIssueBatchContextPatch,
  classifyBatchLane,
  extractBatchIssueIdsFromContext,
  isBatchIssuePickupEnabled,
  isBatchableAssignmentWake,
  isCommentBurstDebounceCandidate,
  readCommentBurstDebounceMs,
  resolveBatchWindowMs,
  selectIssueBatchPickup,
  selectUnfinishedBatchIssuesForRequeue,
  shouldHoldCommentBurstForDebounce,
  shouldHoldSingleBatchableForWindow,
} from "./batch-issue-pickup.js";

describe("batch-issue-pickup policy", () => {
  it("classifies lane windows per operator defaults", () => {
    expect(classifyBatchLane({ role: "ceo", name: "GLaD0S" })).toBe("csuite");
    expect(classifyBatchLane({ role: "cto", name: "CTO-Codex" })).toBe("csuite");
    expect(classifyBatchLane({ name: "Engineer-Hermes", role: "engineer" })).toBe("engineering");
    expect(classifyBatchLane({ name: "Media-Drafter", role: "general" })).toBe("drafter");
    expect(classifyBatchLane({ name: "Astra", role: "system" })).toBe("system");
    expect(resolveBatchWindowMs({ role: "ceo" })).toBe(15 * 60_000);
    expect(resolveBatchWindowMs({ role: "engineer", name: "Engineer-Hermes" })).toBe(10 * 60_000);
    expect(resolveBatchWindowMs({ name: "Content-Drafter" })).toBe(30 * 60_000);
    expect(resolveBatchWindowMs({ name: "Astra", role: "system" })).toBe(0);
  });

  it("keeps SLA/urgent classes exempt from assignment batching", () => {
    for (const reason of [
      "issue_commented",
      "execution_review_requested",
      "paid_delivery_callback",
    ]) {
      expect(BATCH_PICKUP_EXEMPT_WAKE_REASONS.has(reason)).toBe(true);
      expect(
        isBatchableAssignmentWake({
          wakeReason: reason,
          contextSnapshot: { issueId: "i1", wakeReason: reason },
        }),
      ).toBe(false);
    }
    expect(BATCHABLE_ASSIGNMENT_WAKE_REASONS.has("issue_assigned")).toBe(true);
    // A recovery is an explicit continuation of work that was already admitted.
    // Holding it for a writer's batching window looks like a stuck agent and
    // makes a transient failure cost another full context rebuild.
    expect(BATCHABLE_ASSIGNMENT_WAKE_REASONS.has("issue_assignment_recovery")).toBe(false);
    expect(
      isBatchableAssignmentWake({
        wakeReason: "issue_assignment_recovery",
        contextSnapshot: { issueId: "i1", wakeReason: "issue_assignment_recovery" },
      }),
    ).toBe(false);
    expect(
      isBatchableAssignmentWake({
        wakeReason: "issue_assigned",
        contextSnapshot: { issueId: "i1", wakeReason: "issue_assigned" },
      }),
    ).toBe(true);
    expect(
      isBatchableAssignmentWake({
        wakeReason: "issue_assigned",
        contextSnapshot: { issueId: "i1", wakeReason: "issue_assigned", commentId: "c1" },
      }),
    ).toBe(false);
    expect(
      isBatchableAssignmentWake({
        wakeReason: "issue_assigned",
        triggerDetail: "manual",
        contextSnapshot: { issueId: "i1", wakeReason: "issue_assigned" },
      }),
    ).toBe(false);
  });

  it("holds a lone young batchable assignment for the lane window", () => {
    const now = Date.parse("2026-08-08T16:00:00.000Z");
    expect(
      shouldHoldSingleBatchableForWindow({
        runCreatedAt: now - 60_000,
        siblingCount: 0,
        windowMs: 10 * 60_000,
        now,
      }),
    ).toBe(true);
    expect(
      shouldHoldSingleBatchableForWindow({
        runCreatedAt: now - 11 * 60_000,
        siblingCount: 0,
        windowMs: 10 * 60_000,
        now,
      }),
    ).toBe(false);
    expect(
      shouldHoldSingleBatchableForWindow({
        runCreatedAt: now - 1_000,
        siblingCount: 1,
        windowMs: 10 * 60_000,
        now,
      }),
    ).toBe(false);
  });

  it("selects an ordered multi-issue batch when ≥2 assignment wakes are pending", () => {
    const now = Date.parse("2026-08-08T16:00:00.000Z");
    const runs = [
      {
        id: "r1",
        createdAt: now - 30_000,
        contextSnapshot: { issueId: "i1", wakeReason: "issue_assigned" },
      },
      {
        id: "r2",
        createdAt: now - 20_000,
        contextSnapshot: { issueId: "i2", wakeReason: "issue_assigned" },
      },
      {
        id: "r3",
        createdAt: now - 10_000,
        contextSnapshot: { issueId: "i3", wakeReason: "issue_commented", commentId: "c1" },
      },
    ];
    const selection = selectIssueBatchPickup({
      prioritizedRuns: runs,
      agent: { role: "engineer", name: "Engineer-Hermes" },
      now,
      issueMetaById: new Map([
        ["i1", { identifier: "TSMC-1", title: "One", status: "todo", priority: "high" }],
        ["i2", { identifier: "TSMC-2", title: "Two", status: "todo", priority: "medium" }],
      ]),
    });
    expect(selection?.held).toBe(false);
    expect(selection?.siblings.map((run) => run.id)).toEqual(["r2"]);
    expect(selection?.batch.map((entry) => entry.issueId)).toEqual(["i1", "i2"]);
    expect(selection?.batch[0]?.identifier).toBe("TSMC-1");

    const patch = buildIssueBatchContextPatch({
      batch: selection!.batch,
      absorbedRunIds: selection!.siblings.map((run) => run.id),
      laneClass: "engineering",
      windowMs: 10 * 60_000,
    });
    expect(extractBatchIssueIdsFromContext(patch)).toEqual(["i1", "i2"]);
  });

  it("does not batch urgent head wakes even when assignment siblings exist", () => {
    const now = Date.parse("2026-08-08T16:00:00.000Z");
    const selection = selectIssueBatchPickup({
      prioritizedRuns: [
        {
          id: "r-comment",
          createdAt: now - 20 * 60_000,
          contextSnapshot: { issueId: "i1", wakeReason: "issue_commented", commentId: "c1" },
        },
        {
          id: "r-assign",
          createdAt: now - 10_000,
          contextSnapshot: { issueId: "i2", wakeReason: "issue_assigned" },
        },
      ],
      agent: { role: "engineer", name: "Engineer-Hermes" },
      commentDebounceMs: 0,
      now,
    });
    expect(selection?.held).toBe(false);
    expect(selection?.siblings).toEqual([]);
    expect(selection?.batch).toEqual([]);
  });

  it("holds fresh comment wakes for the 300s burst window", () => {
    const now = Date.parse("2026-08-08T16:00:00.000Z");
    expect(isCommentBurstDebounceCandidate({ wakeReason: "issue_commented" })).toBe(true);
    expect(
      shouldHoldCommentBurstForDebounce({
        runCreatedAt: now - 60_000,
        debounceMs: 300_000,
        now,
      }),
    ).toBe(true);
    const selection = selectIssueBatchPickup({
      prioritizedRuns: [
        {
          id: "r-comment",
          createdAt: now - 60_000,
          contextSnapshot: { issueId: "i1", wakeReason: "issue_commented", commentId: "c1" },
        },
      ],
      agent: { role: "engineer", name: "Engineer-Hermes" },
      now,
    });
    expect(selection?.held).toBe(true);
    expect(selection?.holdReason).toBe("comment_burst_debounce");
  });

  it("requeues unfinished sibling batch issues only", () => {
    expect(
      selectUnfinishedBatchIssuesForRequeue({
        batchIssueIds: ["i1", "i2", "i3"],
        primaryIssueId: "i1",
        finishingAgentId: "agent-a",
        issueStates: [
          { id: "i1", status: "in_progress", assigneeAgentId: "agent-a" },
          { id: "i2", status: "todo", assigneeAgentId: "agent-a" },
          { id: "i3", status: "done", assigneeAgentId: "agent-a" },
        ],
      }),
    ).toEqual(["i2"]);
  });

  it("honors kill-switch and env overrides", () => {
    expect(isBatchIssuePickupEnabled({})).toBe(true);
    expect(isBatchIssuePickupEnabled({ PAPERCLIP_BATCH_ISSUE_PICKUP: "false" })).toBe(false);
    expect(readCommentBurstDebounceMs({})).toBe(300_000);
    expect(readCommentBurstDebounceMs({ PAPERCLIP_COMMENT_BURST_DEBOUNCE_MS: "0" })).toBe(0);
    expect(
      resolveBatchWindowMs({
        role: "engineer",
        env: { PAPERCLIP_BATCH_ISSUE_PICKUP_WINDOW_MS: "120000" },
      }),
    ).toBe(120_000);
  });
});
