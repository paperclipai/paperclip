import { describe, expect, it } from "vitest";
import {
  MAX_TOOL_CALL_DIFF_BYTES,
  MAX_TOOL_FILE_DIFF_BYTES,
  toolFileChangesFromAcpContent,
  toolFileChangesFromCodexChanges,
  unifiedHunkFromTexts,
} from "./tool-file-changes.js";

describe("unifiedHunkFromTexts", () => {
  it("keeps unchanged lines as context and marks the edit", () => {
    expect(unifiedHunkFromTexts("a\nb\nc", "a\nB\nc", 10)).toBe(
      ["@@ -10,3 +10,3 @@", " a", "-b", "+B", " c"].join("\n"),
    );
  });

  it("presents a new file as additions only", () => {
    expect(unifiedHunkFromTexts(null, "one\ntwo\n")).toBe(["@@ -0,0 +1,2 @@", "+one", "+two"].join("\n"));
  });
});

describe("toolFileChangesFromAcpContent", () => {
  const cwd = "/work/repo";

  it("maps Claude Edit diff blocks to a workspace-relative patch with counts", () => {
    const [change] = toolFileChangesFromAcpContent(
      [{ type: "diff", path: "/work/repo/src/a.ts", oldText: "x = 1\ny = 2", newText: "x = 1\ny = 3\nz = 4" }],
      [{ path: "/work/repo/src/a.ts", line: 7 }],
      cwd,
    )!;
    expect(change).toMatchObject({ path: "src/a.ts", operation: "modify", additions: 2, deletions: 1, diffTruncated: false });
    expect(change.diff).toContain("@@ -7,2 +7,3 @@");
  });

  it("treats a Write with no old text as a created file", () => {
    const [change] = toolFileChangesFromAcpContent(
      [{ type: "diff", path: "/work/repo/new.js", oldText: null, newText: "a\nb" }],
      [],
      cwd,
    )!;
    expect(change).toMatchObject({ path: "new.js", operation: "create", additions: 2, deletions: 0 });
  });

  it("joins several hunks for one file and drops paths outside the workspace", () => {
    const changes = toolFileChangesFromAcpContent(
      [
        { type: "diff", path: "/work/repo/a.ts", oldText: "1", newText: "2" },
        { type: "diff", path: "/work/repo/a.ts", oldText: "3", newText: "4" },
        { type: "diff", path: "/etc/passwd", oldText: "x", newText: "y" },
        { type: "content", content: { type: "text", text: "ignored" } },
      ],
      [],
      [cwd],
    )!;
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ path: "a.ts", additions: 2, deletions: 2 });
    expect(changes[0].diff!.match(/^@@/gm)).toHaveLength(2);
  });

  it("returns null when the call carried no diff content", () => {
    expect(toolFileChangesFromAcpContent([{ type: "content" }], [], cwd)).toBeNull();
    expect(toolFileChangesFromAcpContent(undefined, [], cwd)).toBeNull();
  });

  it("bounds a large patch at a line boundary and keeps full counts", () => {
    const newText = Array.from({ length: 4_000 }, (_, index) => `line ${index} ${"x".repeat(20)}`).join("\n");
    const [change] = toolFileChangesFromAcpContent([{ type: "diff", path: "big.txt", oldText: null, newText }], [], cwd)!;
    expect(change.additions).toBe(4_000);
    expect(change.diffTruncated).toBe(true);
    expect(Buffer.byteLength(change.diff!)).toBeLessThanOrEqual(MAX_TOOL_FILE_DIFF_BYTES);
    expect(change.diff!.endsWith("x")).toBe(true);
  });
});

describe("toolFileChangesFromCodexChanges", () => {
  it("keeps Codex update patches and turns added-file content into a hunk", () => {
    const changes = toolFileChangesFromCodexChanges(
      [
        { path: "/work/repo/a.js", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-a\n+b\n" },
        { path: "b.js", kind: { type: "add" }, diff: "one\ntwo\n" },
      ],
      "/work/repo",
    )!;
    expect(changes[0]).toMatchObject({ path: "a.js", operation: "modify", additions: 1, deletions: 1 });
    expect(changes[1]).toMatchObject({ path: "b.js", operation: "create", additions: 2, deletions: 0 });
    expect(changes[1].diff).toBe("@@ -0,0 +1,2 @@\n+one\n+two\n");
  });

  it("reports a moved file as a rename", () => {
    const [change] = toolFileChangesFromCodexChanges(
      [{ path: "old.js", kind: { type: "update", move_path: "new.js" }, diff: "" }],
      "/work/repo",
    )!;
    expect(change).toMatchObject({ path: "new.js", previousPath: "old.js", operation: "rename" });
  });
});

describe("byte budgets and hunk content", () => {
  it("keeps every file's counts when multibyte patches exceed the call budget", () => {
    const wide = Array.from({ length: 2_000 }, () => "\u4e2d\u6587\u5185\u5bb9\u4e2d\u6587").join("\n");
    const changes = toolFileChangesFromAcpContent(
      [1, 2, 3].map((index) => ({ type: "diff", path: `f${index}.txt`, oldText: null, newText: wide })),
      [],
      "/work/repo",
    )!;
    expect(changes.map((change) => change.additions)).toEqual([2_000, 2_000, 2_000]);
    const bytes = changes.reduce((sum, change) => sum + (change.diff === null ? 0 : Buffer.byteLength(JSON.stringify(change.diff))), 0);
    expect(bytes).toBeLessThanOrEqual(MAX_TOOL_CALL_DIFF_BYTES);
    expect(changes.some((change) => change.diff === null && change.diffTruncated)).toBe(true);
    for (const change of changes) expect(change.diff ?? "").not.toContain("\uFFFD");
  });

  it("counts removed and added lines that look like file headers inside a hunk", () => {
    const [change] = toolFileChangesFromCodexChanges(
      [{ path: "q.sql", kind: { type: "update", move_path: null }, diff: "@@ -1,2 +1,2 @@\n--- old comment\n+++ new value\n keep\n" }],
      "/work/repo",
    )!;
    expect(change).toMatchObject({ additions: 1, deletions: 1 });
  });
});
