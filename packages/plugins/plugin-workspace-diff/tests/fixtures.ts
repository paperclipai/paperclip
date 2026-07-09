import type { WorkspaceDiffFile, WorkspaceDiffResponse } from "../src/contracts.js";

export function changedFile(overrides: Partial<WorkspaceDiffFile> = {}): WorkspaceDiffFile {
  return {
    path: "src/app.ts",
    oldPath: null,
    status: "modified",
    staged: false,
    unstaged: true,
    untracked: false,
    binary: false,
    oversized: false,
    truncated: false,
    additions: 1,
    deletions: 1,
    sizeBytes: 120,
    patches: [
      {
        kind: "unstaged",
        patch: [
          "diff --git a/src/app.ts b/src/app.ts",
          "index 1111111..2222222 100644",
          "--- a/src/app.ts",
          "+++ b/src/app.ts",
          "@@ -1 +1 @@",
          "-export const value = 1;",
          "+export const value = 2;",
          "",
        ].join("\n"),
        additions: 1,
        deletions: 1,
        binary: false,
        oversized: false,
        truncated: false,
        warnings: [],
      },
    ],
    warnings: [],
    ...overrides,
  };
}

export function diffResponse(overrides: Partial<WorkspaceDiffResponse> = {}): WorkspaceDiffResponse {
  const files = overrides.files ?? [changedFile()];
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    companyId: "22222222-2222-4222-8222-222222222222",
    view: "working-tree",
    baseRef: null,
    defaultBaseRef: null,
    headSha: null,
    includeUntracked: true,
    paths: [],
    files,
    stats: {
      fileCount: files.length,
      stagedFileCount: files.filter((file) => file.staged).length,
      unstagedFileCount: files.filter((file) => file.unstaged).length,
      untrackedFileCount: files.filter((file) => file.untracked).length,
      binaryFileCount: files.filter((file) => file.binary).length,
      oversizedFileCount: files.filter((file) => file.oversized).length,
      truncatedFileCount: files.filter((file) => file.truncated).length,
      additions,
      deletions,
    },
    warnings: [],
    caps: {
      maxFiles: 200,
      maxFileBytes: 524288,
      maxPatchBytes: 131072,
      maxTotalPatchBytes: 1048576,
    },
    truncated: false,
    ...overrides,
  };
}
