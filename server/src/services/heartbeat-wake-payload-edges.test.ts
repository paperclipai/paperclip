import { describe, expect, it, vi } from "vitest";

vi.mock("./plan-review-context.js", () => ({
  buildDocumentReviewContext: vi.fn().mockResolvedValue(null),
  buildPlanReviewContext: vi.fn().mockResolvedValue(null),
}));

import { buildPaperclipWakePayload } from "./heartbeat.js";

function queuedDb(resultSets: unknown[][]) {
  return {
    select: vi.fn(() => {
      const rows = resultSets.shift() ?? [];
      const query: Record<string, unknown> = {};
      for (const method of ["from", "where", "innerJoin", "leftJoin", "orderBy", "limit"]) {
        query[method] = vi.fn(() => query);
      }
      query.then = (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject);
      return query;
    }),
  };
}

describe("heartbeat wake payload edge coverage", () => {
  it("indexes and serializes comment rows", async () => {
    const createdAt = new Date("2026-08-01T00:00:00.000Z");
    const payload = await buildPaperclipWakePayload({
      db: queuedDb([
        [{
          id: "issue-1",
          identifier: "PAP-1",
          title: "Issue",
          description: null,
          status: "in_progress",
          priority: "medium",
          workMode: "standard",
        }],
        [{
          id: "comment-1",
          issueId: "issue-1",
          body: "hello",
          authorType: null,
          authorAgentId: null,
          authorUserId: null,
          presentation: null,
          metadata: null,
          deletedAt: null,
          deletedByType: null,
          deletedByAgentId: null,
          deletedByUserId: null,
          deletedByRunId: null,
          sourceTrust: null,
          createdAt,
        }],
      ]) as never,
      companyId: "company-1",
      contextSnapshot: { issueId: "issue-1", wakeCommentIds: ["comment-1"] },
    });

    expect(payload?.comments).toEqual([
      expect.objectContaining({ id: "comment-1", body: "hello", author: { type: "system", id: null } }),
    ]);
  });

  it("maps annotation deltas and all author fallbacks", async () => {
    const base = {
      issueId: "issue-1",
      threadId: "thread-1",
      documentKey: "plan",
      currentRevisionNumber: 3,
      selectedText: "selection",
      prefixText: "before",
      suffixText: "after",
      status: "open",
      anchorState: "attached",
      anchorConfidence: "exact",
      body: "annotation",
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
    };
    const payload = await buildPaperclipWakePayload({
      db: queuedDb([[
        { ...base, id: "annotation-agent", authorType: "agent", authorAgentId: "agent-1", authorUserId: null },
        { ...base, id: "annotation-user", authorType: "user", authorAgentId: null, authorUserId: "user-1" },
        { ...base, id: "annotation-system", authorType: "system", authorAgentId: null, authorUserId: null },
      ]]) as never,
      companyId: "company-1",
      contextSnapshot: { issueId: "issue-1", annotationCommentId: "annotation-agent" },
      issueSummary: {
        id: "issue-1",
        identifier: "PAP-1",
        title: "Issue",
        description: null,
        status: "in_progress",
        priority: "medium",
        workMode: "standard",
      },
    });

    expect(payload?.annotationDeltas).toEqual([
      expect.objectContaining({ author: { type: "agent", id: "agent-1" } }),
      expect.objectContaining({ author: { type: "user", id: "user-1" } }),
      expect.objectContaining({ author: { type: "system", id: null } }),
    ]);
  });

  it("bounds comment count and aggregate body sizes", async () => {
    const createdAt = new Date("2026-08-01T00:00:00.000Z");
    const issueSummary = {
      id: "issue-1", identifier: "PAP-1", title: "Issue", description: "x".repeat(20_000),
      status: "in_progress", priority: "medium", workMode: "standard",
    };
    const makeRow = (id: string, body: string) => ({
      id, issueId: "issue-1", body, authorType: "system", authorAgentId: null, authorUserId: null,
      presentation: null, metadata: null, deletedAt: null, deletedByType: null, deletedByAgentId: null,
      deletedByUserId: null, deletedByRunId: null, sourceTrust: null, createdAt,
    });
    const countIds = Array.from({ length: 25 }, (_, index) => `comment-${index}`);
    const countPayload = await buildPaperclipWakePayload({
      db: queuedDb([countIds.map((id) => makeRow(id, ""))]) as never,
      companyId: "company-1",
      contextSnapshot: { issueId: "issue-1", wakeCommentIds: countIds },
      issueSummary,
    });
    expect(countPayload?.truncated).toBe(true);

    const bodyIds = Array.from({ length: 6 }, (_, index) => `body-${index}`);
    const bodyPayload = await buildPaperclipWakePayload({
      db: queuedDb([bodyIds.map((id) => makeRow(id, "b".repeat(10_000)))]) as never,
      companyId: "company-1",
      contextSnapshot: { issueId: "issue-1", wakeCommentIds: bodyIds },
      issueSummary: { ...issueSummary, description: null },
    });
    expect(bodyPayload?.comments.some((comment) => comment.bodyTruncated === true)).toBe(true);
    expect(bodyPayload?.truncated).toBe(true);
  });
});
