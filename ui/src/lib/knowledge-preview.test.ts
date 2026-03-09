// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildKnowledgePreview } from "./knowledge-preview";

describe("buildKnowledgePreview", () => {
  it("returns null for empty note bodies", () => {
    expect(buildKnowledgePreview(null)).toBeNull();
    expect(buildKnowledgePreview("   \n  ")).toBeNull();
  });

  it("preserves line breaks while trimming outer whitespace", () => {
    expect(buildKnowledgePreview("  line one\nline two  ", 80)).toBe("line one\nline two");
  });

  it("clamps very long note bodies to a bounded preview", () => {
    const preview = buildKnowledgePreview("x".repeat(120), 32);

    expect(preview).toBe("x".repeat(31) + "…");
    expect(preview).toHaveLength(32);
  });
});
