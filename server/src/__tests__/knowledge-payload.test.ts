import { describe, expect, it } from "vitest";
import { buildKnowledgePayloadForUpdate } from "../services/knowledge.js";

describe("buildKnowledgePayloadForUpdate", () => {
  it("keeps note updates compatible with the note schema", () => {
    const payload = buildKnowledgePayloadForUpdate(
      {
        id: "11111111-1111-4111-8111-111111111111",
        companyId: "cmp-1",
        title: "Existing note",
        kind: "note",
        summary: "Old summary",
        body: "Old body",
        assetId: null,
        sourceUrl: null,
        createdByAgentId: null,
        createdByUserId: "user-1",
        createdAt: new Date("2026-03-07T12:00:00Z"),
        updatedAt: new Date("2026-03-07T12:00:00Z"),
      } as any,
      {
        title: "Updated note",
        summary: "New summary",
        body: "New body",
      },
    );

    expect(payload).toEqual({
      title: "Updated note",
      kind: "note",
      summary: "New summary",
      body: "New body",
    });
  });
});
