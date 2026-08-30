import { describe, expect, it } from "vitest";

import { parseCodexTurnDiff } from "./codex-turn-diff.js";

describe("Codex turn diff parser", () => {
  it("parses a complete snapshot with bounded file statistics", () => {
    expect(parseCodexTurnDiff([
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 95%",
      "rename from src/old.ts",
      "rename to src/new.ts",
      "--- a/src/old.ts",
      "+++ b/src/new.ts",
      "@@ -1 +1,2 @@",
      "-old",
      "+new",
      "+another",
      "diff --git a/assets/image.png b/assets/image.png",
      "Binary files a/assets/image.png and b/assets/image.png differ",
    ].join("\n"))).toEqual([
      expect.objectContaining({
        path: "src/new.ts",
        previousPath: "src/old.ts",
        operation: "rename",
        additions: 2,
        deletions: 1,
        binary: false,
      }),
      expect.objectContaining({
        path: "assets/image.png",
        operation: "modify",
        additions: null,
        deletions: null,
        binary: true,
      }),
    ]);
  });

  it("bounds aggregate diffs and rejects unsafe workspace paths", () => {
    const patches = Array.from({ length: 2_001 }, (_, index) => [
      `diff --git a/src/file-${index}.ts b/src/file-${index}.ts`,
      `--- a/src/file-${index}.ts`,
      `+++ b/src/file-${index}.ts`,
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n"));
    expect(parseCodexTurnDiff(patches.join("\n"))).toHaveLength(2_000);

    const oversized = parseCodexTurnDiff([
      "diff --git a/src/large.ts b/src/large.ts",
      "--- a/src/large.ts",
      "+++ b/src/large.ts",
      "@@ -0,0 +1 @@",
      `+${"x".repeat(300_000)}`,
    ].join("\n"));
    expect(oversized[0]?.diff).toHaveLength(256 * 1_024);

    expect(parseCodexTurnDiff([
      "diff --git a/../../secret.txt b/../../secret.txt",
      "--- a/../../secret.txt",
      "+++ b/../../secret.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n"))).toEqual([]);

    expect(parseCodexTurnDiff([
      String.raw`diff --git a/C:\Windows\secret.txt b/C:\Windows\secret.txt`,
      String.raw`--- a/C:\Windows\secret.txt`,
      String.raw`+++ b/C:\Windows\secret.txt`,
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n"))).toEqual([]);
  });

  it("keeps file headers distinct from hunk content with marker prefixes", () => {
    expect(parseCodexTurnDiff([
      "diff --git a/src/markers.ts b/src/markers.ts",
      "--- a/src/markers.ts",
      "+++ b/src/markers.ts",
      "@@ -1 +1 @@",
      "--- old content",
      "+++ new content",
    ].join("\n"))).toEqual([
      expect.objectContaining({
        path: "src/markers.ts",
        operation: "modify",
        additions: 1,
        deletions: 1,
      }),
    ]);
  });

  it("does not split file records for diff headers embedded in hunk lines", () => {
    const firstPatch = [
      "diff --git a/src/first.ts b/src/first.ts",
      "--- a/src/first.ts",
      "+++ b/src/first.ts",
      "@@ -1,2 +1,2 @@",
      "diff --git a/decoded-context.ts b/decoded-context.ts",
      " diff --git a/context.ts b/context.ts",
      "-diff --git a/deleted.ts b/deleted.ts",
      "+diff --git a/added.ts b/added.ts",
    ];
    const secondPatch = [
      "diff --git a/src/second.ts b/src/second.ts",
      "--- a/src/second.ts",
      "+++ b/src/second.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ];

    expect(parseCodexTurnDiff([...firstPatch, ...secondPatch].join("\n"))).toEqual([
      expect.objectContaining({
        path: "src/first.ts",
        additions: 1,
        deletions: 1,
        diff: `${firstPatch.join("\n")}\n`,
      }),
      expect.objectContaining({
        path: "src/second.ts",
        additions: 1,
        deletions: 1,
        diff: `${secondPatch.join("\n")}\n`,
      }),
    ]);
  });

  it("does not interpret rename or mode metadata after a hunk begins", () => {
    expect(parseCodexTurnDiff([
      "diff --git a/src/markers.ts b/src/markers.ts",
      "--- a/src/markers.ts",
      "+++ b/src/markers.ts",
      "@@ -1 +1 @@",
      "rename from ../../outside.ts",
      "rename to src/renamed.ts",
      "old mode 100644",
      "new mode 100755",
      "-old",
      "+new",
    ].join("\n"))).toEqual([
      expect.objectContaining({
        path: "src/markers.ts",
        previousPath: null,
        operation: "modify",
        additions: 1,
        deletions: 1,
      }),
    ]);
  });

  it("does not interpret binary markers after a text hunk begins", () => {
    const patch = [
      "diff --git a/src/markers.ts b/src/markers.ts",
      "--- a/src/markers.ts",
      "+++ b/src/markers.ts",
      "@@ -1 +1 @@",
      "Binary files are described in this text hunk",
      "GIT binary patch",
      "-old",
      "+new",
    ].join("\n");

    expect(parseCodexTurnDiff(patch)).toEqual([
      expect.objectContaining({
        path: "src/markers.ts",
        operation: "modify",
        additions: 1,
        deletions: 1,
        binary: false,
        diff: `${patch}\n`,
      }),
    ]);
  });
});
