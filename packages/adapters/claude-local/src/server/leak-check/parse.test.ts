import { describe, expect, it } from "vitest";
// The shim parser is plain ESM JS to remain self-contained for subprocess
// spawn; import it here for direct assertions.
import { parseGhArgs, parseGitArgs } from "./parse.mjs";

describe("parseGhArgs", () => {
  it("extracts --body, --title, --body-file from gh pr create", () => {
    const parsed = parseGhArgs([
      "pr",
      "create",
      "--title",
      "My PR",
      "--body",
      "Hello world",
      "--body-file",
      "body.md",
    ]);
    expect(parsed.subCommand).toBe("pr");
    expect(parsed.verb).toBe("create");
    expect(parsed.unsupported).toBe(false);
    expect(parsed.scanTargets).toEqual([
      { kind: "string", source: "gh --title", value: "My PR" },
      { kind: "string", source: "gh --body", value: "Hello world" },
      { kind: "file", source: "gh --body-file", path: "body.md" },
    ]);
  });

  it("handles attached-equals form (--body=)", () => {
    const parsed = parseGhArgs(["pr", "edit", "--body=Hello"]);
    expect(parsed.scanTargets).toEqual([
      { kind: "string", source: "gh --body=", value: "Hello" },
    ]);
  });

  it("treats --body-file - as stdin", () => {
    const parsed = parseGhArgs(["pr", "comment", "42", "--body-file", "-"]);
    expect(parsed.scanTargets).toEqual([
      { kind: "stdin", source: "gh --body-file" },
    ]);
  });

  it("extracts -f body and -F body=@file targets for gh api", () => {
    const parsed = parseGhArgs([
      "api",
      "repos/foo/bar/pulls/1/comments",
      "-f",
      "body=hello",
      "-F",
      "body=@review.md",
    ]);
    expect(parsed.subCommand).toBe("api");
    expect(parsed.scanTargets).toEqual([
      { kind: "string", source: "gh api -f body=", value: "hello" },
      { kind: "file", source: "gh api -F body=@", path: "review.md" },
    ]);
  });

  it("treats unrecognized gh subcommands as unsupported (pass-through)", () => {
    const parsed = parseGhArgs(["auth", "status"]);
    expect(parsed.unsupported).toBe(true);
    expect(parsed.scanTargets).toEqual([]);
  });

  it("recognizes --allow-leak-OK and strips it from scan", () => {
    const parsed = parseGhArgs(["pr", "create", "--body", "x", "--allow-leak-OK"]);
    expect(parsed.hasAllowOverride).toBe(true);
    expect(parsed.scanTargets).toEqual([
      { kind: "string", source: "gh --body", value: "x" },
    ]);
  });

  it("scans gh release create --notes / --notes-file", () => {
    const parsed = parseGhArgs([
      "release",
      "create",
      "v1.0",
      "--notes",
      "rel-notes",
      "--notes-file",
      "rel.md",
    ]);
    expect(parsed.scanTargets).toEqual([
      { kind: "string", source: "gh --notes", value: "rel-notes" },
      { kind: "file", source: "gh --notes-file", path: "rel.md" },
    ]);
  });
});

describe("parseGitArgs", () => {
  it("extracts -m and -F from git commit", () => {
    const parsed = parseGitArgs(["commit", "-m", "Hello commit", "-F", "msg.txt"]);
    expect(parsed.subCommand).toBe("commit");
    expect(parsed.scanTargets).toEqual([
      { kind: "string", source: "git commit -m", value: "Hello commit" },
      { kind: "file", source: "git commit -F", path: "msg.txt" },
    ]);
  });

  it("treats git commit -F - as stdin", () => {
    const parsed = parseGitArgs(["commit", "-F", "-"]);
    expect(parsed.scanTargets).toEqual([
      { kind: "stdin", source: "git commit -F" },
    ]);
  });

  it("handles attached --message= / --file= forms", () => {
    const parsed = parseGitArgs(["commit", "--message=Hello", "--file=body.txt"]);
    expect(parsed.scanTargets).toEqual([
      { kind: "string", source: "git commit --message=", value: "Hello" },
      { kind: "file", source: "git commit --file=", path: "body.txt" },
    ]);
  });

  it("skips git pre-subcommand opts like -C dir and --git-dir=", () => {
    const parsed = parseGitArgs([
      "-C",
      "/tmp/work",
      "--git-dir=.git",
      "commit",
      "-m",
      "Hello",
    ]);
    expect(parsed.subCommand).toBe("commit");
    expect(parsed.scanTargets).toEqual([
      { kind: "string", source: "git commit -m", value: "Hello" },
    ]);
  });

  it("treats non-body git subcommands as unsupported (pass-through)", () => {
    expect(parseGitArgs(["status"]).unsupported).toBe(true);
    expect(parseGitArgs(["push", "origin", "main"]).unsupported).toBe(true);
  });

  it("scans git tag -m and -F", () => {
    const parsed = parseGitArgs(["tag", "-m", "release msg", "v1"]);
    expect(parsed.scanTargets).toEqual([
      { kind: "string", source: "git tag -m", value: "release msg" },
    ]);
  });

  it("strips --allow-leak-OK from git argv", () => {
    const parsed = parseGitArgs(["commit", "-m", "x", "--allow-leak-OK"]);
    expect(parsed.hasAllowOverride).toBe(true);
    expect(parsed.scanTargets).toEqual([
      { kind: "string", source: "git commit -m", value: "x" },
    ]);
  });
});
