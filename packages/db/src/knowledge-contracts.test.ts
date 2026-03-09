import { describe, expect, it } from "vitest";
import {
  attachIssueKnowledgeItemSchema,
  createKnowledgeItemSchema,
  updateKnowledgeItemSchema,
} from "@paperclipai/shared";

describe("knowledge item contracts", () => {
  it("requires note items to include a body", () => {
    const result = createKnowledgeItemSchema.safeParse({
      title: "API access notes",
      kind: "note",
    });

    expect(result.success).toBe(false);
  });

  it("requires asset items to include an asset id", () => {
    const result = createKnowledgeItemSchema.safeParse({
      title: "Audit artifact",
      kind: "asset",
      summary: "Q1 audit output",
    });

    expect(result.success).toBe(false);
  });

  it("requires url items to include a source url", () => {
    const result = createKnowledgeItemSchema.safeParse({
      title: "API docs",
      kind: "url",
      summary: "Reference docs",
    });

    expect(result.success).toBe(false);
  });

  it("accepts partial updates without changing kind", () => {
    const result = updateKnowledgeItemSchema.safeParse({
      title: "Updated title",
      summary: "Tighter wording",
    });

    expect(result.success).toBe(true);
  });

  it("requires a knowledge item id when attaching to an issue", () => {
    const result = attachIssueKnowledgeItemSchema.safeParse({});

    expect(result.success).toBe(false);
  });
});
