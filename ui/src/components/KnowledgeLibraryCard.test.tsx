// @vitest-environment node
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { KnowledgeItem } from "@paperclipai/shared";
import { KnowledgeLibraryCard } from "./KnowledgeLibraryCard";

vi.mock("../lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("./KnowledgeKindBadge", () => ({
  KnowledgeKindBadge: ({ kind }: { kind: string }) => <span>{kind}</span>,
}));

function knowledgeItem(
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
    asset: null,
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: null,
    updatedByUserId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("KnowledgeLibraryCard", () => {
  it("keeps open in the top action row and hides note body previews", () => {
    const item = knowledgeItem({
      id: "knowledge-1",
      title: "Billing incident checklist",
      summary: "Reusable steps for finance-related incidents",
      body: "This internal note body should not appear in the library card.",
    });

    const markup = renderToStaticMarkup(
      <KnowledgeLibraryCard
        item={item}
        updatedLabel="Updated 3h ago"
        onEdit={() => {}}
        onDelete={() => {}}
      />
    );

    expect(markup).toContain("Billing incident checklist");
    expect(markup).toContain("Reusable steps for finance-related incidents");
    expect(markup).toContain("Open");
    expect(markup).toContain("/knowledge/knowledge-1");
    expect(markup).toContain("Updated 3h ago");
    expect(markup).not.toContain(
      "This internal note body should not appear in the library card."
    );
    expect(markup).not.toContain("border-b");
    expect(markup).toContain("pt-6");
  });
});
