import { describe, expect, it } from "vitest";
import type { IssueKnowledgeAttachment } from "@paperclipai/shared";
import { applyIssueKnowledgeContext } from "../services/knowledge-context.js";

const attachment: IssueKnowledgeAttachment = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  companyId: "cmp-1",
  issueId: "issue-1",
  knowledgeItemId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  sortOrder: 0,
  createdByAgentId: null,
  createdByUserId: "user-1",
  createdAt: new Date("2026-03-07T12:00:00Z"),
  updatedAt: new Date("2026-03-07T12:00:00Z"),
  knowledgeItem: {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    companyId: "cmp-1",
    title: "Stripe access notes",
    kind: "note",
    summary: "How agents should use Stripe",
    body: "Use STRIPE_SECRET_KEY from company secrets.",
    assetId: null,
    sourceUrl: null,
    createdByAgentId: null,
    createdByUserId: "user-1",
    createdAt: new Date("2026-03-07T11:00:00Z"),
    updatedAt: new Date("2026-03-07T11:00:00Z"),
    asset: null,
    contentText: null,
  },
};

describe("applyIssueKnowledgeContext", () => {
  it("injects attached issue knowledge into context snapshots", () => {
    const context = applyIssueKnowledgeContext(
      {
        issueId: "issue-1",
      },
      [attachment],
    );

    expect(context).toMatchObject({
      issueId: "issue-1",
      paperclipKnowledgeItems: [
        {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          title: "Stripe access notes",
          kind: "note",
          summary: "How agents should use Stripe",
          body: "Use STRIPE_SECRET_KEY from company secrets.",
        },
      ],
    });
  });

  it("omits the knowledge field when no issue knowledge is attached", () => {
    const context = applyIssueKnowledgeContext(
      {
        issueId: "issue-1",
      },
      [],
    );

    expect(context).toEqual({
      issueId: "issue-1",
    });
  });
});
