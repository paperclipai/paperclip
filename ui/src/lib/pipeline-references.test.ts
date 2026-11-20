import { describe, expect, it } from "vitest";
import { extractWorkReferences, referenceFieldKeys, type WorkReference } from "./pipeline-references";

function kinds(refs: WorkReference[]) {
  return refs.map((ref) => ref.kind);
}

describe("extractWorkReferences", () => {
  it("returns nothing for a case with no references", () => {
    expect(extractWorkReferences({ fields: { topic: "Launch", count: 3 } })).toEqual([]);
  });

  it("surfaces the workspaceRef column as a workspace reference", () => {
    const refs = extractWorkReferences({
      workspaceRef: { path: "/content/blog", branch: "feature/blog" },
      fields: {},
    });
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ kind: "workspace", path: "/content/blog", branch: "feature/blog" });
  });

  it("detects a bare URL string field", () => {
    const refs = extractWorkReferences({ fields: { draft_link: "https://docs.example.com/x" } });
    expect(refs[0]).toMatchObject({ kind: "url", url: "https://docs.example.com/x", label: "Draft link" });
  });

  it("ignores non-http strings", () => {
    expect(extractWorkReferences({ fields: { note: "just text" } })).toEqual([]);
  });

  it("detects an explicit url record", () => {
    const refs = extractWorkReferences({
      fields: { asset: { kind: "url", url: "https://cdn.example.com/i.png", label: "Hero image" } },
    });
    expect(refs[0]).toMatchObject({ kind: "url", url: "https://cdn.example.com/i.png", label: "Hero image" });
  });

  it("detects an issue reference record", () => {
    const refs = extractWorkReferences({
      fields: { work: { issueId: "issue-1", identifier: "PAP-99", title: "Write blog" } },
    });
    expect(refs[0]).toMatchObject({ kind: "issue", issueId: "issue-1", identifier: "PAP-99", label: "Write blog" });
  });

  it("detects a workspace-shaped field record", () => {
    const refs = extractWorkReferences({ fields: { folder: { path: "/assets", kind: "workspace" } } });
    expect(refs[0]).toMatchObject({ kind: "workspace", path: "/assets" });
  });

  it("combines workspaceRef and field references in order", () => {
    const refs = extractWorkReferences({
      workspaceRef: { path: "/root" },
      fields: {
        link: "https://example.com",
        work: { issueIdentifier: "PAP-1" },
      },
    });
    expect(kinds(refs)).toEqual(["workspace", "url", "issue"]);
  });

  it("reports reference field keys for exclusion from the plain list", () => {
    const fields = { link: "https://example.com", topic: "Launch", work: { issueId: "i1" } };
    const keys = referenceFieldKeys(fields);
    expect(keys.has("link")).toBe(true);
    expect(keys.has("work")).toBe(true);
    expect(keys.has("topic")).toBe(false);
  });
});
