// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { KnowledgeItem } from "@paperclipai/shared";
import { filterKnowledgeItems } from "./knowledge-selection";

function note(
  overrides: Partial<KnowledgeItem> & Pick<KnowledgeItem, "id" | "title">
): KnowledgeItem {
  const now = new Date("2026-03-07T00:00:00.000Z");
  return {
    companyId: "company-1",
    kind: "note",
    summary: null,
    body: null,
    assetId: null,
    sourceUrl: null,
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: null,
    updatedByUserId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("filterKnowledgeItems", () => {
  it("filters by title, summary, body, and source url while excluding ids", () => {
    const items = [
      note({
        id: "1",
        title: "Stripe access notes",
        summary: "Billing access flow",
      }),
      note({
        id: "2",
        title: "Incident doc",
        body: "Use STRIPE_SECRET_KEY from company secrets",
      }),
      note({
        id: "3",
        title: "Runbook",
        kind: "url",
        sourceUrl: "https://docs.example.com/stripe/setup",
      }),
      note({ id: "4", title: "Hidden by attach state" }),
    ];

    const result = filterKnowledgeItems(items, "stripe", new Set(["4"]));

    expect(result.map((item) => item.id)).toEqual(["1", "2", "3"]);
  });

  it("sorts title matches ahead of summary and body matches", () => {
    const items = [
      note({
        id: "body",
        title: "Finance checklist",
        body: "Contains billing incident steps",
      }),
      note({
        id: "summary",
        title: "Checklist",
        summary: "Billing incident overview",
      }),
      note({ id: "title", title: "Billing incident checklist" }),
    ];

    const result = filterKnowledgeItems(items, "billing");

    expect(result.map((item) => item.id)).toEqual(["title", "summary", "body"]);
  });
});
