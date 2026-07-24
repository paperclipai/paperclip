import { z } from "@paperclipai/plugin-sdk";

export const workspaceDiffViewSchema = z.enum(["working-tree", "head"]);

export const workspaceDiffFileStatusSchema = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "type_changed",
  "untracked",
  "unknown",
]);

export const workspaceDiffPatchKindSchema = z.enum(["staged", "unstaged", "head", "untracked"]);

export const workspaceDiffWarningCodeSchema = z.enum([
  "base_ref_missing",
  "base_ref_invalid",
  "binary_file",
  "file_count_truncated",
  "file_oversized",
  "git_command_failed",
  "missing_cwd",
  "non_git_workspace",
  "patch_truncated",
  "path_filter_invalid",
  "symlink_target_outside_workspace",
  "workspace_path_invalid",
]);

const queryBooleanSchema = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((value) => value === true || value === "true");

function normalizePathQuery(value: unknown): string[] {
  if (value == null) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((entry) => {
    if (typeof entry !== "string") return [];
    return entry
      .split(",")
      .map((filePath) => filePath.trim())
      .filter(Boolean);
  });
}

export const workspaceDiffQuerySchema = z
  .object({
    view: workspaceDiffViewSchema.optional().default("working-tree"),
    baseRef: z.string().trim().min(1).max(240).optional().nullable(),
    includeUntracked: queryBooleanSchema.optional().default(true),
    path: z.union([z.string(), z.array(z.string())]).optional(),
    paths: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .passthrough()
  .transform((value) => ({
    view: value.view,
    baseRef: value.baseRef?.trim() || null,
    includeUntracked: value.includeUntracked,
    paths: normalizePathQuery(value.paths ?? value.path),
  }));

export const workspaceDiffWarningSchema = z.object({
  code: workspaceDiffWarningCodeSchema,
  message: z.string(),
  path: z.string().nullable(),
}).strict();

export const workspaceDiffCapsSchema = z.object({
  maxFiles: z.number().int().positive(),
  maxFileBytes: z.number().int().positive(),
  maxPatchBytes: z.number().int().positive(),
  maxTotalPatchBytes: z.number().int().positive(),
}).strict();

export const workspaceDiffFilePatchSchema = z.object({
  kind: workspaceDiffPatchKindSchema,
  patch: z.string().nullable(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  binary: z.boolean(),
  oversized: z.boolean(),
  truncated: z.boolean(),
  warnings: z.array(workspaceDiffWarningSchema),
}).strict();

export const workspaceDiffFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  status: workspaceDiffFileStatusSchema,
  staged: z.boolean(),
  unstaged: z.boolean(),
  untracked: z.boolean(),
  binary: z.boolean(),
  oversized: z.boolean(),
  truncated: z.boolean(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  patches: z.array(workspaceDiffFilePatchSchema),
  warnings: z.array(workspaceDiffWarningSchema),
}).strict();

export const workspaceDiffStatsSchema = z.object({
  fileCount: z.number().int().nonnegative(),
  stagedFileCount: z.number().int().nonnegative(),
  unstagedFileCount: z.number().int().nonnegative(),
  untrackedFileCount: z.number().int().nonnegative(),
  binaryFileCount: z.number().int().nonnegative(),
  oversizedFileCount: z.number().int().nonnegative(),
  truncatedFileCount: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
}).strict();

export const workspaceDiffResponseSchema = z.object({
  workspaceId: z.string(),
  companyId: z.string(),
  view: workspaceDiffViewSchema,
  baseRef: z.string().nullable(),
  defaultBaseRef: z.string().nullable(),
  headSha: z.string().nullable(),
  includeUntracked: z.boolean(),
  paths: z.array(z.string()),
  files: z.array(workspaceDiffFileSchema),
  stats: workspaceDiffStatsSchema,
  warnings: z.array(workspaceDiffWarningSchema),
  caps: workspaceDiffCapsSchema,
  truncated: z.boolean(),
}).strict();

export type WorkspaceDiffView = z.infer<typeof workspaceDiffViewSchema>;
export type WorkspaceDiffFileStatus = z.infer<typeof workspaceDiffFileStatusSchema>;
export type WorkspaceDiffPatchKind = z.infer<typeof workspaceDiffPatchKindSchema>;
export type WorkspaceDiffWarningCode = z.infer<typeof workspaceDiffWarningCodeSchema>;
export type WorkspaceDiffQueryOptions = z.infer<typeof workspaceDiffQuerySchema>;
export type WorkspaceDiffWarning = z.infer<typeof workspaceDiffWarningSchema>;
export type WorkspaceDiffCaps = z.infer<typeof workspaceDiffCapsSchema>;
export type WorkspaceDiffFilePatch = z.infer<typeof workspaceDiffFilePatchSchema>;
export type WorkspaceDiffFile = z.infer<typeof workspaceDiffFileSchema>;
export type WorkspaceDiffStats = z.infer<typeof workspaceDiffStatsSchema>;
export type WorkspaceDiffResponse = z.infer<typeof workspaceDiffResponseSchema>;
