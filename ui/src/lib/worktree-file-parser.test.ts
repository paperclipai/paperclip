import { describe, expect, it } from "vitest";
import { parseWorktreeFileRef, formatWorktreeFileRefDisplay } from "./worktree-file-parser";

describe("parseWorkspaceFileRef", () => {
  it("parses a simple workspace-relative path", () => {
    const ref = parseWorktreeFileRef("ui/src/pages/IssueDetail.tsx");
    expect(ref).toEqual({
      path: "ui/src/pages/IssueDetail.tsx",
      resourceKind: "file",
      line: null,
      column: null,
      raw: "ui/src/pages/IssueDetail.tsx",
    });
  });

  it("parses path:line suffixes", () => {
    const ref = parseWorktreeFileRef("ui/src/pages/IssueDetail.tsx:42");
    expect(ref?.path).toBe("ui/src/pages/IssueDetail.tsx");
    expect(ref?.line).toBe(42);
    expect(ref?.column).toBe(null);
  });

  it("parses path:line:column suffixes", () => {
    const ref = parseWorktreeFileRef("ui/src/pages/IssueDetail.tsx:42:3");
    expect(ref?.line).toBe(42);
    expect(ref?.column).toBe(3);
  });

  it("parses #L42 style anchors", () => {
    const ref = parseWorktreeFileRef("packages/shared/src/index.ts#L42");
    expect(ref?.path).toBe("packages/shared/src/index.ts");
    expect(ref?.line).toBe(42);
  });

  it("parses #L42C3 style anchors", () => {
    const ref = parseWorktreeFileRef("packages/shared/src/index.ts#L42C3");
    expect(ref?.line).toBe(42);
    expect(ref?.column).toBe(3);
  });

  it("rejects absolute unix paths", () => {
    expect(parseWorktreeFileRef("/etc/passwd")).toBeNull();
  });

  it("rejects absolute windows paths", () => {
    expect(parseWorktreeFileRef("C:\\Users\\foo\\file.txt")).toBeNull();
  });

  it("rejects paths that escape with ..", () => {
    expect(parseWorktreeFileRef("../secrets/file.env")).toBeNull();
    expect(parseWorktreeFileRef("foo/../secrets.txt")).toBeNull();
  });

  it("rejects home-relative paths", () => {
    expect(parseWorktreeFileRef("~/.ssh/id_rsa")).toBeNull();
  });

  it("rejects paths with null bytes or backslashes", () => {
    expect(parseWorktreeFileRef("foo\\bar.txt")).toBeNull();
    expect(parseWorktreeFileRef("foo\0bar.txt")).toBeNull();
  });

  it("rejects plain prose words with an extension", () => {
    expect(parseWorktreeFileRef("README.md")).toBeNull();
  });

  it("accepts paths without extension when deeply nested", () => {
    const ref = parseWorktreeFileRef("scripts/setup/install");
    expect(ref?.path).toBe("scripts/setup/install");
  });

  it("parses trailing-slash directory refs", () => {
    const ref = parseWorktreeFileRef("content-os/cases/active/2026-06-06-pap-10199-bundled-skills/");
    expect(ref).toEqual({
      path: "content-os/cases/active/2026-06-06-pap-10199-bundled-skills/",
      resourceKind: "directory",
      line: null,
      column: null,
      raw: "content-os/cases/active/2026-06-06-pap-10199-bundled-skills/",
    });
  });

  it("rejects one-segment directory refs because they are too ambiguous to route", () => {
    expect(parseWorktreeFileRef("sources/")).toBeNull();
  });

  it("rejects unsafe directory refs", () => {
    expect(parseWorktreeFileRef("../secrets/")).toBeNull();
    expect(parseWorktreeFileRef("foo/../secrets/")).toBeNull();
    expect(parseWorktreeFileRef("~/secrets/")).toBeNull();
    expect(parseWorktreeFileRef("C:/Users/foo/")).toBeNull();
    expect(parseWorktreeFileRef("foo\\bar/")).toBeNull();
  });

  it("formats the display string with line and column", () => {
    expect(formatWorktreeFileRefDisplay({ path: "a/b.ts", resourceKind: "file", line: 5, column: 10, raw: "a/b.ts:5:10" })).toBe("a/b.ts:5:10");
    expect(formatWorktreeFileRefDisplay({ path: "a/b.ts", resourceKind: "file", line: 5, column: null, raw: "a/b.ts:5" })).toBe("a/b.ts:5");
    expect(formatWorktreeFileRefDisplay({ path: "a/b.ts", resourceKind: "file", line: null, column: null, raw: "a/b.ts" })).toBe("a/b.ts");
  });

  it("rejects line numbers that are zero or negative", () => {
    const ref = parseWorktreeFileRef("ui/a.ts:0");
    expect(ref).toBeNull();
  });

  it("returns null for empty or whitespace input", () => {
    expect(parseWorktreeFileRef("")).toBeNull();
    expect(parseWorktreeFileRef("   ")).toBeNull();
  });
});
