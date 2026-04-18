import { describe, expect, it } from "vitest";
import type { IssueReviewItem } from "@paperclipai/shared";
import { getGroupedIssueReviewItems, getReviewItemsForComment } from "./review-items";

function makeReviewItem(overrides: Partial<IssueReviewItem> = {}): IssueReviewItem {
  return {
    id: "item-1",
    kind: "generic_link",
    group: "references",
    title: "example.com",
    subtitle: "example.com/listing",
    summary: null,
    previewState: "ready",
    status: "new",
    thumbnailUrl: null,
    resolvedTarget: { url: "https://example.com/listing" },
    sourceRefs: [
      {
        sourceType: "issue_comment",
        sourceId: "comment-1",
        commentId: "comment-1",
        authorAgentId: "agent-1",
        authorUserId: null,
        createdAt: new Date("2026-04-17T10:00:00.000Z"),
      },
    ],
    mentionCount: 1,
    metadata: null,
    ...overrides,
  };
}

describe("review item helpers", () => {
  it("groups review items into board sections in the intended order", () => {
    const groups = getGroupedIssueReviewItems([
      makeReviewItem({
        id: "item-review",
        group: "review_now",
        kind: "work_product",
        title: "Published listing preview",
      }),
      makeReviewItem({
        id: "item-reference",
        group: "references",
        kind: "file",
        title: "wallapop.txt",
        resolvedTarget: { path: "ops/listing-templates/wallapop.txt" },
      }),
      makeReviewItem({
        id: "item-hidden",
        group: "hidden_context",
        kind: "missing",
        title: "stale-url.txt",
        previewState: "missing",
        status: "unavailable",
      }),
    ]);

    expect(groups.map((group) => group.key)).toEqual([
      "review_now",
      "references",
      "hidden_context",
    ]);
    expect(groups.map((group) => group.title)).toEqual([
      "Review now",
      "References",
      "Hidden context",
    ]);
    expect(groups[0]?.collapsedByDefault).toBe(false);
    expect(groups[2]?.collapsedByDefault).toBe(true);
  });

  it("returns only the review items sourced from a given comment id", () => {
    const matching = makeReviewItem({
      id: "item-match",
      kind: "file",
      title: "wallapop.txt",
      resolvedTarget: { path: "ops/listing-templates/wallapop.txt" },
    });
    const nonMatching = makeReviewItem({
      id: "item-other",
      title: "preview.paperclip.local",
      sourceRefs: [
        {
          sourceType: "issue_comment",
          sourceId: "comment-2",
          commentId: "comment-2",
          authorAgentId: "agent-1",
          authorUserId: null,
          createdAt: new Date("2026-04-17T11:00:00.000Z"),
        },
      ],
    });

    expect(getReviewItemsForComment([matching, nonMatching], "comment-1")).toEqual([matching]);
    expect(getReviewItemsForComment([matching, nonMatching], "comment-2")).toEqual([nonMatching]);
    expect(getReviewItemsForComment([matching, nonMatching], "missing-comment")).toEqual([]);
  });
});
