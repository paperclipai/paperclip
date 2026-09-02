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

  it("fails closed for malformed, overflowing, and incomplete hunks", () => {
    const completeFile = [
      "diff --git a/src/complete.ts b/src/complete.ts",
      "--- a/src/complete.ts",
      "+++ b/src/complete.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ];

    expect(parseCodexTurnDiff([
      ...completeFile,
      "diff --git a/src/malformed.ts b/src/malformed.ts",
      "--- a/src/malformed.ts",
      "+++ b/src/malformed.ts",
      "@@ -1 +not-a-count @@",
      "diff --git a/src/fabricated.ts b/src/fabricated.ts",
    ].join("\n"))).toEqual([
      expect.objectContaining({ path: "src/complete.ts" }),
    ]);

    expect(parseCodexTurnDiff([
      ...completeFile,
      "diff --git a/src/incomplete-tail.ts b/src/incomplete-tail.ts",
      "--- a/src/incomplete-tail.ts",
      "+++ b/src/incomplete-tail.ts",
      "@@ -1,2 +1,2 @@",
      "diff --git a/src/fake.ts b/src/fake.ts",
      " unchanged",
      "-old",
      "+new",
      "diff --git a/src/later.ts b/src/later.ts",
      "--- a/src/later.ts",
      "+++ b/src/later.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n"))).toEqual([
      expect.objectContaining({ path: "src/complete.ts" }),
    ]);

    expect(parseCodexTurnDiff([
      ...completeFile,
      "diff --git a/src/overflow.ts b/src/overflow.ts",
      "--- a/src/overflow.ts",
      "+++ b/src/overflow.ts",
      "@@ -9007199254740992 +1 @@",
    ].join("\n"))).toEqual([
      expect.objectContaining({ path: "src/complete.ts" }),
    ]);

    expect(parseCodexTurnDiff([
      "diff --git a/src/incomplete.ts b/src/incomplete.ts",
      "--- a/src/incomplete.ts",
      "+++ b/src/incomplete.ts",
      "@@ -1,2 +1,2 @@",
      "-old",
      "+new",
    ].join("\n"))).toEqual([]);
  });

  it.each([
    { label: "an added-line overrun", header: "@@ -1 +1,0 @@", lines: ["+unexpected", "-old"] },
    { label: "a deleted-line overrun", header: "@@ -1,0 +1 @@", lines: ["-unexpected", "+new"] },
    { label: "a context-line side overrun", header: "@@ -1,0 +1 @@", lines: [" unchanged", "+new"] },
    { label: "content after both sides are complete", header: "@@ -1 +1 @@", lines: ["-old", "+new", "+extra"] },
  ])("rejects $label", ({ header, lines }) => {
    expect(parseCodexTurnDiff([
      "diff --git a/src/overrun.ts b/src/overrun.ts",
      "--- a/src/overrun.ts",
      "+++ b/src/overrun.ts",
      header,
      ...lines,
    ].join("\n"))).toEqual([]);
  });

  it("supports multiple hunks, zero-count sides, and no-newline markers", () => {
    const patch = [
      "diff --git a/src/multiple.ts b/src/multiple.ts",
      "--- a/src/multiple.ts",
      "+++ b/src/multiple.ts",
      "@@ -0,0 +1 @@",
      "+added",
      "\\ No newline at end of file",
      "@@ -2 +2,0 @@",
      "-removed",
      "\\ No newline at end of file",
      "diff --git a/src/next.ts b/src/next.ts",
      "--- a/src/next.ts",
      "+++ b/src/next.ts",
      "@@ -0,0 +1 @@",
      "+next",
    ].join("\n");

    expect(parseCodexTurnDiff(patch)).toEqual([
      expect.objectContaining({
        path: "src/multiple.ts",
        additions: 1,
        deletions: 1,
      }),
      expect.objectContaining({
        path: "src/next.ts",
        additions: 1,
        deletions: 0,
      }),
    ]);
  });

  it("does not interpret rename or mode metadata after a hunk begins", () => {
    expect(parseCodexTurnDiff([
      "diff --git a/src/markers.ts b/src/markers.ts",
      "--- a/src/markers.ts",
      "+++ b/src/markers.ts",
      "@@ -1,5 +1,5 @@",
      " rename from ../../outside.ts",
      " rename to src/renamed.ts",
      " old mode 100644",
      " new mode 100755",
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
      "@@ -1,3 +1,3 @@",
      " Binary files are described in this text hunk",
      " GIT binary patch",
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
