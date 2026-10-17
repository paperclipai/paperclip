import { describe, expect, it } from "vitest";
import {
  boundExecutionContinuationEnvelope,
  omitDeletedContinuationMessages,
} from "./execution-continuation-budget.js";

function continuationMessage(
  id: string,
  body: string,
  extra: { deleted?: boolean } = {},
) {
  return {
    id,
    authorType: "agent",
    authorId: "agent",
    createdByRunId: "run",
    body,
    createdAt: "2026-10-16T00:00:00.000Z",
    updatedAt: "2026-10-16T00:00:00.000Z",
    deleted: extra.deleted === true,
    sourceTrust: null,
  };
}

function envelopeBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

describe("execution continuation budget", () => {
  it("omits deleted tombstones and keeps live empty bodies", () => {
    const tombstone = continuationMessage("deleted", "", { deleted: true });
    const liveEmpty = continuationMessage("empty", "");
    const live = continuationMessage("live", "keep me");
    const result = omitDeletedContinuationMessages([tombstone, liveEmpty, live]);
    expect(result.messages.map((message) => message.id)).toEqual(["empty", "live"]);
    expect(result.omittedDeletedIds).toEqual(["deleted"]);
  });

  it("drops oldest history first so a large thread stays under the byte budget", () => {
    const origin = continuationMessage("origin", "trigger");
    const oldest = continuationMessage("oldest", "x".repeat(8_000));
    const middle = continuationMessage("middle", "y".repeat(8_000));
    const newest = continuationMessage("newest", "z".repeat(8_000));
    const envelope = {
      version: 1 as const,
      companyId: "company",
      issueId: "issue",
      trigger: { reason: "task_execution", interactionId: null, sourceRunId: null },
      originCommentIds: ["origin"],
      objective: "Do the work.",
      messages: [oldest, middle, origin, newest],
      interactionOutcomes: [],
      completedWork: null,
      unresolvedInteractionIds: [],
      coverage: {
        kind: "full_task_history" as const,
        throughCommentId: "newest",
        summaryThroughCommentId: null,
      },
    };
    const bounded = boundExecutionContinuationEnvelope(envelope, ["origin"], 12_000);
    expect(envelopeBytes(bounded)).toBeLessThanOrEqual(12_000);
    expect(bounded.coverage.kind).toBe("truncated_task_history");
    expect(bounded.messages.map((message) => message.id)).not.toContain("oldest");
    expect(bounded.messages.map((message) => message.id)).toContain("origin");
    expect(bounded.messages.at(-1)?.id).toBe("newest");
    expect(bounded.coverage.omittedCount).toBeGreaterThan(0);
  });

  it("drops duplicated non-origin history before blanking an origin wake comment", () => {
    const origin = continuationMessage("origin", "o".repeat(5_000));
    const extra = continuationMessage("extra", "e".repeat(4_000));
    const envelope = {
      version: 1 as const,
      companyId: "company",
      issueId: "issue",
      trigger: { reason: "task_execution", interactionId: null, sourceRunId: null },
      originCommentIds: ["origin"],
      objective: "Do the work.",
      messages: [origin, extra],
      resumeDelta: { baseRunId: "run", messages: [origin, extra] },
      interactionOutcomes: [],
      completedWork: null,
      unresolvedInteractionIds: [],
      coverage: {
        kind: "full_task_history" as const,
        throughCommentId: "extra",
        summaryThroughCommentId: null,
      },
    };
    const fullBytes = envelopeBytes(envelope);
    const originOnly = {
      ...envelope,
      messages: [origin],
      resumeDelta: { baseRunId: "run", messages: [origin] },
    };
    const originOnlyBytes = envelopeBytes(originOnly);
    expect(fullBytes).toBeGreaterThan(originOnlyBytes);
    const budget = originOnlyBytes + 200;
    expect(fullBytes).toBeGreaterThan(budget);
    const bounded = boundExecutionContinuationEnvelope(envelope, ["origin"], budget);
    expect(envelopeBytes(bounded)).toBeLessThanOrEqual(budget);
    expect(bounded.messages.map((message) => message.id)).toEqual(["origin"]);
    expect(bounded.messages[0]?.body).toBe(origin.body);
    expect(bounded.resumeDelta?.messages.map((message) => message.id)).toEqual(["origin"]);
    expect(bounded.resumeDelta?.messages[0]?.body).toBe(origin.body);
    expect(bounded.coverage.kind).toBe("truncated_task_history");
  });

  it("keeps the returned envelope under budget after truncation metadata and bulky sidecars", () => {
    const origin = continuationMessage("origin", "trigger");
    const extra = continuationMessage("extra", "x".repeat(3_000));
    const envelope = {
      version: 1 as const,
      companyId: "company",
      issueId: "issue",
      trigger: { reason: "task_execution", interactionId: null, sourceRunId: null },
      originCommentIds: ["origin"],
      objective: "Do the work.",
      messages: [origin, extra],
      interactionOutcomes: [
        { id: "card", kind: "ask_user_questions", status: "answered", result: { a: "r".repeat(4_000) } },
      ],
      completedActions: [
        { runId: "run", receiptId: "r", operationId: "op", result: { blob: "c".repeat(4_000) } },
      ],
      completedWork: "w".repeat(4_000),
      unresolvedInteractionIds: [],
      coverage: {
        kind: "full_task_history" as const,
        throughCommentId: "extra",
        summaryThroughCommentId: null,
      },
    };
    const bounded = boundExecutionContinuationEnvelope(envelope, ["origin"], 6_000);
    expect(envelopeBytes(bounded)).toBeLessThanOrEqual(6_000);
    expect(bounded.coverage.kind).toBe("truncated_task_history");
    expect(bounded.coverage.omittedCount).toBeDefined();
    expect(bounded.completedWork).toBeNull();
  });

  it("marks sidecar-only trims as truncated even with no comments dropped", () => {
    const origin = continuationMessage("origin", "trigger");
    const envelope = {
      version: 1 as const,
      companyId: "company",
      issueId: "issue",
      trigger: { reason: "task_execution", interactionId: null, sourceRunId: null },
      originCommentIds: ["origin"],
      objective: "Do the work.",
      messages: [origin],
      completedWork: "w".repeat(4_000),
      completedActions: [
        { runId: "run", receiptId: "r", operationId: "op", result: { blob: "c".repeat(4_000) } },
      ],
      unresolvedInteractionIds: [],
      coverage: {
        kind: "full_task_history" as const,
        throughCommentId: "origin",
        summaryThroughCommentId: null,
      },
    };
    const bounded = boundExecutionContinuationEnvelope(envelope, ["origin"], 2_000);
    expect(envelopeBytes(bounded)).toBeLessThanOrEqual(2_000);
    expect(bounded.messages.map((message) => message.id)).toEqual(["origin"]);
    expect(bounded.completedWork).toBeNull();
    expect(bounded.coverage.kind).toBe("truncated_task_history");
  });

  it("counts both copies when estimating a duplicated non-origin drop", () => {
    const origin = continuationMessage("origin", "o".repeat(200));
    const first = continuationMessage("first", "a".repeat(18_000));
    const second = continuationMessage("second", "b".repeat(18_000));
    const third = continuationMessage("third", "c".repeat(18_000));
    const envelope = {
      version: 1 as const,
      companyId: "company",
      issueId: "issue",
      trigger: { reason: "task_execution", interactionId: null, sourceRunId: null },
      originCommentIds: ["origin"],
      objective: "Do the work.",
      messages: [first, second, third, origin],
      resumeDelta: { baseRunId: "run", messages: [first, second, third, origin] },
      interactionOutcomes: [],
      completedWork: null,
      unresolvedInteractionIds: [],
      coverage: {
        kind: "full_task_history" as const,
        throughCommentId: "origin",
        summaryThroughCommentId: null,
      },
    };
    const afterOneDrop = {
      ...envelope,
      messages: [second, third, origin],
      resumeDelta: { baseRunId: "run", messages: [second, third, origin] },
      coverage: {
        ...envelope.coverage,
        kind: "truncated_task_history" as const,
        omittedCount: 1,
        oldestRetainedCommentId: "second",
        throughCommentId: "origin",
      },
    };
    const afterOneDropBytes = envelopeBytes(afterOneDrop);
    expect(afterOneDropBytes).toBeLessThan(80_000);
    expect(envelopeBytes(envelope)).toBeGreaterThan(80_000);
    const bounded = boundExecutionContinuationEnvelope(envelope, ["origin"], 80_000);
    expect(envelopeBytes(bounded)).toBeLessThanOrEqual(80_000);
    expect(bounded.messages.map((message) => message.id)).toEqual(["second", "third", "origin"]);
    expect(bounded.resumeDelta?.messages.map((message) => message.id)).toEqual([
      "second",
      "third",
      "origin",
    ]);
    expect(bounded.coverage.kind).toBe("truncated_task_history");
  });

  it("keeps the returned envelope under budget when leftover ids exceed it", () => {
    const origin = continuationMessage("origin", "trigger");
    const envelope = {
      version: 1 as const,
      companyId: "company",
      issueId: "issue",
      trigger: { reason: "task_execution", interactionId: null, sourceRunId: null },
      originCommentIds: ["origin"],
      objective: "Do the work.",
      messages: [origin],
      interactionOutcomes: [],
      completedWork: null,
      unresolvedInteractionIds: Array.from({ length: 400 }, (_, index) => `pending-${index}`),
      coverage: {
        kind: "full_task_history" as const,
        throughCommentId: "origin",
        summaryThroughCommentId: null,
        omittedDeletedIds: Array.from({ length: 400 }, (_, index) => `deleted-${index}`),
      },
    };
    const bounded = boundExecutionContinuationEnvelope(envelope, ["origin"], 1_200);
    expect(envelopeBytes(bounded)).toBeLessThanOrEqual(1_200);
    expect(bounded.coverage.kind).toBe("truncated_task_history");
    expect(bounded.unresolvedInteractionIds).toEqual(["pending-0"]);
    expect(bounded.coverage.omittedDeletedIds).toBeUndefined();
  });

  it("drops deleted-comment ids before pending interaction ids", () => {
    const origin = continuationMessage("origin", "trigger");
    const pendingId = "40416c31-0000-4000-8000-000000000001";
    const envelope = {
      version: 1 as const,
      companyId: "company",
      issueId: "issue",
      trigger: { reason: "task_execution", interactionId: null, sourceRunId: null },
      originCommentIds: ["origin"],
      objective: "Do the work.",
      messages: [origin],
      interactionOutcomes: [],
      completedWork: null,
      unresolvedInteractionIds: [pendingId],
      coverage: {
        kind: "full_task_history" as const,
        throughCommentId: "origin",
        summaryThroughCommentId: null,
        omittedDeletedIds: Array.from({ length: 400 }, (_, index) => `deleted-${index}`),
      },
    };
    const withoutDeletedIds = {
      ...envelope,
      coverage: {
        ...envelope.coverage,
        omittedDeletedIds: undefined,
      },
    };
    expect(envelopeBytes(envelope)).toBeGreaterThan(1_200);
    expect(envelopeBytes(withoutDeletedIds)).toBeLessThanOrEqual(1_200);
    const bounded = boundExecutionContinuationEnvelope(envelope, ["origin"], 1_200);
    expect(envelopeBytes(bounded)).toBeLessThanOrEqual(1_200);
    expect(bounded.coverage.kind).toBe("truncated_task_history");
    expect(bounded.coverage.omittedDeletedIds).toBeUndefined();
    expect(bounded.unresolvedInteractionIds).toEqual([pendingId]);
    expect(bounded.messages.map((message) => message.id)).toEqual(["origin"]);
    expect(bounded.objective).toBe("Do the work.");
  });
});
