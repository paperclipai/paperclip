import { describe, expect, it } from "vitest";
import {
  MENTION_ATTENTION_LOOKBACK_DAYS,
  MENTION_ATTENTION_ROW_LIMIT,
  buildMentionAttentionItems,
} from "./attention.js";

function comment(overrides: Record<string, unknown> = {}) {
  return {
    id: "comment-1",
    issueId: "issue-1",
    body: "nothing here",
    authorAgentId: null,
    authorUserId: null,
    authorAgentName: null,
    issueIdentifier: "TES-42",
    issueTitle: "Publish forecast",
    issueStatus: "todo",
    createdAt: new Date("2026-09-01T10:00:00.000Z"),
    updatedAt: new Date("2026-09-01T10:00:00.000Z"),
    ...overrides,
  };
}

const base = {
  companyId: "company-1",
  prefix: "TES",
  userId: "user-1",
};

describe("mention attention items", () => {
  it("builds an item for comments that mention the viewer", () => {
    const items = buildMentionAttentionItems({
      ...base,
      comments: [
        comment({ id: "c1", body: "Hey [@tejas](user://user-1), review this." }),
        comment({ id: "c2", body: "No mentions at all." }),
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      companyId: "company-1",
      sourceKind: "mention",
      whyNow: "You were mentioned in a comment.",
      severity: "low",
      inlineResolvable: false,
      dedupKey: "mention:c1",
      decisionVerbs: [],
    });
    expect(items[0]?.subject).toMatchObject({
      kind: "issue",
      id: "issue-1",
      identifier: "TES-42",
      href: "/TES/issues/TES-42",
    });
    expect(items[0]?.detail).toMatchObject({
      kind: "mention",
      commentId: "c1",
      authorLabel: null,
    });
    expect(typeof (items[0]?.detail as { commentExcerpt?: unknown })?.commentExcerpt).toBe("string");
  });

  it("attributes agent authors and skips self-mentions", () => {
    const items = buildMentionAttentionItems({
      ...base,
      comments: [
        comment({
          id: "c3",
          body: "[@tejas](user://user-1) look",
          authorAgentId: "agent-9",
          authorAgentName: "Fable",
        }),
        comment({
          id: "c4",
          body: "note to self [@me](user://user-1)",
          authorUserId: "user-1",
        }),
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.whyNow).toBe("Fable mentioned you in a comment.");
    expect(items[0]?.detail).toMatchObject({ authorLabel: "Fable" });
  });

  it("falls back to the issue id when no identifier exists", () => {
    const items = buildMentionAttentionItems({
      ...base,
      comments: [comment({ issueIdentifier: null, body: "[x](user://user-1)" })],
    });
    expect(items[0]?.subject.href).toBe("/TES/issues/issue-1");
  });

  it("exposes sane bounds", () => {
    expect(MENTION_ATTENTION_LOOKBACK_DAYS).toBe(30);
    expect(MENTION_ATTENTION_ROW_LIMIT).toBe(200);
  });
});
