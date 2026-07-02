import { describe, expect, it } from "vitest";
import {
  buildFilePatch,
  buildFilePatches,
  diffSummary,
  initialExpandedFileSet,
  LONG_DIFF_LINE_THRESHOLD,
  nextExpandedFileSet,
  statusLabel,
  toFileViewModels,
} from "../src/diff-model.js";
import { changedFile, diffResponse } from "./fixtures.js";

describe("workspace diff UI model", () => {
  it("summarizes changed files and line counts", () => {
    const diff = diffResponse();

    expect(diffSummary(diff)).toMatchObject({
      changedLabel: "1 file",
      lineLabel: "+1 / -1",
      warningCount: 0,
      truncated: false,
    });
    expect(toFileViewModels(diff)[0]).toMatchObject({
      path: "src/app.ts",
      status: "modified",
      patchKinds: ["unstaged"],
      lineCount: 7,
      longDiff: false,
    });
  });

  it("represents empty workspace diffs", () => {
    const diff = diffResponse({ files: [] });

    expect(toFileViewModels(diff)).toEqual([]);
    expect(diffSummary(diff).changedLabel).toBe("0 files");
  });

  it("surfaces truncation and file warnings", () => {
    const warning = { code: "patch_truncated" as const, message: "Patch was truncated.", path: "src/app.ts" };
    const file = changedFile({
      truncated: true,
      warnings: [warning],
      patches: [],
    });
    const diff = diffResponse({ files: [file], truncated: true, warnings: [warning] });

    expect(buildFilePatch(file)).toBeNull();
    expect(toFileViewModels(diff)[0]?.warnings).toEqual([warning]);
    expect(diffSummary(diff)).toMatchObject({
      warningCount: 1,
      truncated: true,
    });
  });

  it("does not duplicate aggregated patch warnings", () => {
    const warning = { code: "patch_truncated" as const, message: "Patch was truncated.", path: "src/app.ts" };
    const file = changedFile({
      warnings: [warning],
      patches: [
        {
          kind: "unstaged",
          patch: null,
          additions: 0,
          deletions: 0,
          binary: false,
          oversized: false,
          truncated: true,
          warnings: [warning],
        },
      ],
    });
    const diff = diffResponse({ files: [file], warnings: [warning] });

    expect(toFileViewModels(diff)[0]?.warnings).toEqual([warning]);
    expect(diffSummary(diff).warningCount).toBe(1);
  });

  it("keeps staged and unstaged patches renderable as separate single-file diffs", () => {
    const stagedPatch = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 1111111..2222222 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1 +1 @@",
      "-export const value = 1;",
      "+export const value = 2;",
      "",
    ].join("\n");
    const unstagedPatch = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 2222222..3333333 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -3 +3 @@",
      "-export const label = 'old';",
      "+export const label = 'new';",
      "",
    ].join("\n");
    const file = changedFile({
      staged: true,
      unstaged: true,
      patches: [
        {
          kind: "staged",
          patch: stagedPatch,
          additions: 1,
          deletions: 1,
          binary: false,
          oversized: false,
          truncated: false,
          warnings: [],
        },
        {
          kind: "unstaged",
          patch: unstagedPatch,
          additions: 1,
          deletions: 1,
          binary: false,
          oversized: false,
          truncated: false,
          warnings: [],
        },
      ],
    });

    const patches = buildFilePatches(file);
    const viewModel = toFileViewModels(diffResponse({ files: [file] }))[0];

    expect(buildFilePatch(file)).toBe(stagedPatch.trimEnd());
    expect(patches.map((patch) => patch.kind)).toEqual(["staged", "unstaged"]);
    expect(patches.map((patch) => patch.patch?.match(/^diff --git/gm)?.length ?? 0)).toEqual([1, 1]);
    expect(viewModel?.patches).toHaveLength(2);
    expect(viewModel?.patchKinds).toEqual(["staged", "unstaged"]);
  });

  it("marks long text diffs so the UI can fold them by default", () => {
    const longPatch = [
      "diff --git a/src/large.ts b/src/large.ts",
      "index 1111111..2222222 100644",
      "--- a/src/large.ts",
      "+++ b/src/large.ts",
      "@@ -1,1 +1,1 @@",
      ...Array.from({ length: LONG_DIFF_LINE_THRESHOLD }, (_, index) => `+export const value${index} = ${index};`),
      "",
    ].join("\n");
    const files = toFileViewModels(diffResponse({
      files: [
        changedFile({ path: "src/small.ts" }),
        changedFile({
          path: "src/large.ts",
          additions: LONG_DIFF_LINE_THRESHOLD,
          deletions: 0,
          patches: [
            {
              kind: "unstaged",
              patch: longPatch,
              additions: LONG_DIFF_LINE_THRESHOLD,
              deletions: 0,
              binary: false,
              oversized: false,
              truncated: false,
              warnings: [],
            },
          ],
        }),
      ],
    }));
    const longFile = files.find((file) => file.path === "src/large.ts");
    const defaultExpanded = initialExpandedFileSet(files);

    expect(longFile?.lineCount).toBeGreaterThan(LONG_DIFF_LINE_THRESHOLD);
    expect(longFile?.longDiff).toBe(true);
    expect(defaultExpanded.has("src/small.ts")).toBe(true);
    expect(defaultExpanded.has("src/large.ts")).toBe(false);
  });

  it("toggles expanded file state without mutating the current set", () => {
    const current = new Set(["a.ts"]);
    const collapsed = nextExpandedFileSet(current, "a.ts");
    const expanded = nextExpandedFileSet(current, "b.ts");

    expect(current.has("a.ts")).toBe(true);
    expect(collapsed.has("a.ts")).toBe(false);
    expect(expanded.has("b.ts")).toBe(true);
  });

  it("labels file statuses for the sidebar", () => {
    expect(statusLabel("untracked")).toBe("Untracked");
    expect(statusLabel("type_changed")).toBe("Type changed");
  });
});
