// @vitest-environment node
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { KnowledgeItem } from "@paperclipai/shared";
import { IssueKnowledgeCompactRow } from "./IssueKnowledgeCompactRow";

vi.mock("../lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
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

describe("IssueKnowledgeCompactRow", () => {
  it("renders a compact row with title and open action only", () => {
    const item = knowledgeItem({
      id: "knowledge-1",
      title: "Billing runbook",
      summary: "This summary should not be rendered in the issue panel.",
      body: "This body should stay on the detail page only.",
    });

    const markup = renderToStaticMarkup(
      <IssueKnowledgeCompactRow
        knowledgeItem={item}
        detaching={false}
        onDetach={() => {}}
      />
    );

    expect(markup).toContain("Billing runbook");
    expect(markup).toContain("Open");
    expect(markup).toContain("/knowledge/knowledge-1");
    expect(markup).not.toContain(
      "This summary should not be rendered in the issue panel."
    );
    expect(markup).not.toContain(
      "This body should stay on the detail page only."
    );
  });
});
