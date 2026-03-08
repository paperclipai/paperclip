// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { KnowledgeItem } from "@paperclipai/shared";
import { getKnowledgeLibraryAuxiliaryText } from "./knowledge-library";

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

describe("getKnowledgeLibraryAuxiliaryText", () => {
  it("does not surface note body text in company library cards", () => {
    const item = knowledgeItem({
      id: "note-1",
      title: "Stripe access notes",
      kind: "note",
      body: "Internal note body that should stay on the detail page.",
    });

    expect(getKnowledgeLibraryAuxiliaryText(item)).toBeNull();
  });

  it("returns the source url for url knowledge items", () => {
    const item = knowledgeItem({
      id: "url-1",
      title: "Runbook",
      kind: "url",
      sourceUrl: "https://docs.example.com/runbook",
    });

    expect(getKnowledgeLibraryAuxiliaryText(item)).toBe(
      "https://docs.example.com/runbook"
    );
  });

  it("prefers asset filename over asset id for asset knowledge items", () => {
    const item = knowledgeItem({
      id: "asset-1",
      title: "Billing export",
      kind: "asset",
      assetId: "asset_123",
      asset: {
        assetId: "asset_123",
        companyId: "company-1",
        provider: "local",
        objectKey: "knowledge/asset_123",
        contentPath: "/assets/asset_123",
        originalFilename: "billing-export.csv",
        contentType: "text/csv",
        byteSize: 128,
        sha256: "deadbeef",
        createdByAgentId: null,
        createdByUserId: null,
        createdAt: new Date("2026-03-07T00:00:00.000Z"),
        updatedAt: new Date("2026-03-07T00:00:00.000Z"),
      },
    });

    expect(getKnowledgeLibraryAuxiliaryText(item)).toBe("billing-export.csv");
  });
});
