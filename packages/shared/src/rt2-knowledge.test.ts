import { describe, expect, it } from "vitest";
import {
  getRt2WikiPageSchema,
  listRt2WikiPagesSchema,
  previewRt2KnowledgeVaultImportSchema,
  projectRt2KnowledgeSchema,
  rt2WikiPageTypeSchema,
} from "./validators/rt2-knowledge.js";

describe("rt2 knowledge validators", () => {
  it("accepts known wiki page types", () => {
    expect(rt2WikiPageTypeSchema.parse("index")).toBe("index");
    expect(rt2WikiPageTypeSchema.parse("log")).toBe("log");
    expect(rt2WikiPageTypeSchema.parse("topic")).toBe("topic");
  });

  it("normalizes list query limits", () => {
    expect(listRt2WikiPagesSchema.parse({ pageType: "topic", limit: "10" })).toEqual({
      pageType: "topic",
      limit: 10,
    });
  });

  it("guards page keys and projection limits", () => {
    expect(getRt2WikiPageSchema.parse({ pageKey: "index.md" })).toEqual({ pageKey: "index.md" });
    expect(() => getRt2WikiPageSchema.parse({ pageKey: "" })).toThrow();
    expect(projectRt2KnowledgeSchema.parse({ limit: 25 })).toEqual({ limit: 25 });
    expect(() => projectRt2KnowledgeSchema.parse({ limit: 1000 })).toThrow();
  });

  it("validates Obsidian vault import preview bundles", () => {
    expect(
      previewRt2KnowledgeVaultImportSchema.parse({
        vaultName: "rt2-company-demo",
        files: [{ path: "index.md", content: "---\nrt2_page_key: index.md\n---\n# Index" }],
      }),
    ).toEqual({
      vaultName: "rt2-company-demo",
      files: [{ path: "index.md", content: "---\nrt2_page_key: index.md\n---\n# Index" }],
    });
    expect(() => previewRt2KnowledgeVaultImportSchema.parse({ files: [] })).toThrow();
  });
});
