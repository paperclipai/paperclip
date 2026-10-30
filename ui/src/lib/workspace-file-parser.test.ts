import { describe, expect, it } from "vitest";
import { parseWorkspaceFileRef, formatWorkspaceFileRefDisplay } from "./workspace-file-parser";

describe("parseWorkspaceFileRef", () => {
  it("parses a simple workspace-relative path", () => {
    const ref = parseWorkspaceFileRef("ui/src/pages/IssueDetail.tsx");
    expect(ref).toEqual({
      path: "ui/src/pages/IssueDetail.tsx",
      resourceKind: "file",
      line: null,
      column: null,
      raw: "ui/src/pages/IssueDetail.tsx",
    });
  });

  it("parses path:line suffixes", () => {
    const ref = parseWorkspaceFileRef("ui/src/pages/IssueDetail.tsx:42");
    expect(ref?.path).toBe("ui/src/pages/IssueDetail.tsx");
    expect(ref?.line).toBe(42);
    expect(ref?.column).toBe(null);
  });

  it("parses path:line:column suffixes", () => {
    const ref = parseWorkspaceFileRef("ui/src/pages/IssueDetail.tsx:42:3");
    expect(ref?.line).toBe(42);
    expect(ref?.column).toBe(3);
  });

  it("parses #L42 style anchors", () => {
    const ref = parseWorkspaceFileRef("packages/shared/src/index.ts#L42");
    expect(ref?.path).toBe("packages/shared/src/index.ts");
    expect(ref?.line).toBe(42);
  });

  it("parses #L42C3 style anchors", () => {
    const ref = parseWorkspaceFileRef("packages/shared/src/index.ts#L42C3");
    expect(ref?.line).toBe(42);
    expect(ref?.column).toBe(3);
  });

  it("rejects absolute unix paths", () => {
    expect(parseWorkspaceFileRef("/etc/passwd")).toBeNull();
  });

  it("rejects absolute windows paths", () => {
    expect(parseWorkspaceFileRef("C:\\Users\\foo\\file.txt")).toBeNull();
  });

  it("rejects paths that escape with ..", () => {
    expect(parseWorkspaceFileRef("../secrets/file.env")).toBeNull();
    expect(parseWorkspaceFileRef("foo/../secrets.txt")).toBeNull();
  });

  it("rejects home-relative paths", () => {
    expect(parseWorkspaceFileRef("~/.ssh/id_rsa")).toBeNull();
  });

  it("rejects paths with null bytes or backslashes", () => {
    expect(parseWorkspaceFileRef("foo\\bar.txt")).toBeNull();
    expect(parseWorkspaceFileRef("foo\0bar.txt")).toBeNull();
  });

  it("rejects plain prose words with an extension", () => {
    expect(parseWorkspaceFileRef("README.md")).toBeNull();
  });

  it("accepts paths without extension when deeply nested", () => {
    const ref = parseWorkspaceFileRef("scripts/setup/install");
    expect(ref?.path).toBe("scripts/setup/install");
  });

  it("parses trailing-slash directory refs", () => {
    const ref = parseWorkspaceFileRef("content-os/cases/active/2026-06-06-pap-10199-bundled-skills/");
    expect(ref).toEqual({
      path: "content-os/cases/active/2026-06-06-pap-10199-bundled-skills/",
      resourceKind: "directory",
      line: null,
      column: null,
      raw: "content-os/cases/active/2026-06-06-pap-10199-bundled-skills/",
    });
  });

  it("rejects one-segment directory refs because they are too ambiguous to route", () => {
    expect(parseWorkspaceFileRef("sources/")).toBeNull();
  });

  it("rejects unsafe directory refs", () => {
    expect(parseWorkspaceFileRef("../secrets/")).toBeNull();
    expect(parseWorkspaceFileRef("foo/../secrets/")).toBeNull();
    expect(parseWorkspaceFileRef("~/secrets/")).toBeNull();
    expect(parseWorkspaceFileRef("C:/Users/foo/")).toBeNull();
    expect(parseWorkspaceFileRef("foo\\bar/")).toBeNull();
  });

  it("formats the display string with line and column", () => {
    expect(formatWorkspaceFileRefDisplay({ path: "a/b.ts", resourceKind: "file", line: 5, column: 10, raw: "a/b.ts:5:10" })).toBe("a/b.ts:5:10");
    expect(formatWorkspaceFileRefDisplay({ path: "a/b.ts", resourceKind: "file", line: 5, column: null, raw: "a/b.ts:5" })).toBe("a/b.ts:5");
    expect(formatWorkspaceFileRefDisplay({ path: "a/b.ts", resourceKind: "file", line: null, column: null, raw: "a/b.ts" })).toBe("a/b.ts");
  });

  it("rejects line numbers that are zero or negative", () => {
    const ref = parseWorkspaceFileRef("ui/a.ts:0");
    expect(ref).toBeNull();
  });

  it("returns null for empty or whitespace input", () => {
    expect(parseWorkspaceFileRef("")).toBeNull();
    expect(parseWorkspaceFileRef("   ")).toBeNull();
  });
});
