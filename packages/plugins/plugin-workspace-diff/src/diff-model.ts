import type {
  WorkspaceDiffFile,
  WorkspaceDiffFilePatch,
  WorkspaceDiffResponse,
  WorkspaceDiffWarning,
} from "./contracts.js";

export type DiffRenderMode = "unified" | "split";

export interface DiffPatchViewModel {
  kind: WorkspaceDiffFilePatch["kind"];
  patch: string | null;
  lineCount: number;
  additions: number;
  deletions: number;
  binary: boolean;
  oversized: boolean;
  truncated: boolean;
  warnings: WorkspaceDiffWarning[];
}

export interface DiffFileViewModel {
  path: string;
  oldPath: string | null;
  status: WorkspaceDiffFile["status"];
  additions: number;
  deletions: number;
  binary: boolean;
  oversized: boolean;
  truncated: boolean;
  warnings: WorkspaceDiffWarning[];
  patchKinds: WorkspaceDiffFilePatch["kind"][];
  patches: DiffPatchViewModel[];
  patch: string | null;
  lineCount: number;
  longDiff: boolean;
}

export interface DiffSummaryViewModel {
  changedLabel: string;
  lineLabel: string;
  warningCount: number;
  truncated: boolean;
}

const STATUS_LABELS: Record<WorkspaceDiffFile["status"], string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
  copied: "Copied",
  type_changed: "Type changed",
  untracked: "Untracked",
  unknown: "Changed",
};

export const LONG_DIFF_LINE_THRESHOLD = 400;

export function statusLabel(status: WorkspaceDiffFile["status"]) {
  return STATUS_LABELS[status] ?? "Changed";
}

export function fileName(filePath: string) {
  return filePath.split("/").filter(Boolean).pop() ?? filePath;
}

export function buildFilePatches(file: WorkspaceDiffFile): DiffPatchViewModel[] {
  return file.patches.map((patch) => {
    const textPatch = patch.patch?.trimEnd() ?? null;
    const lineCount = textPatch ? textPatch.split("\n").length : 0;
    return {
      kind: patch.kind,
      patch: textPatch && textPatch.length > 0 ? textPatch : null,
      lineCount,
      additions: patch.additions,
      deletions: patch.deletions,
      binary: patch.binary,
      oversized: patch.oversized,
      truncated: patch.truncated,
      warnings: patch.warnings,
    };
  });
}

export function buildFilePatch(file: WorkspaceDiffFile): string | null {
  return buildFilePatches(file).find((patch) => patch.patch)?.patch ?? null;
}

export function isLongDiffFile(file: Pick<DiffFileViewModel, "lineCount">) {
  return file.lineCount > LONG_DIFF_LINE_THRESHOLD;
}

export function toFileViewModels(diff: WorkspaceDiffResponse | null | undefined): DiffFileViewModel[] {
  return (diff?.files ?? []).map((file) => {
    const patches = buildFilePatches(file);
    const lineCount = patches.reduce((count, patch) => count + patch.lineCount, 0);
    return {
      path: file.path,
      oldPath: file.oldPath,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      binary: file.binary,
      oversized: file.oversized,
      truncated: file.truncated,
      warnings: file.warnings,
      patchKinds: file.patches.map((patch) => patch.kind),
      patches,
      patch: patches.find((patch) => patch.patch)?.patch ?? null,
      lineCount,
      longDiff: isLongDiffFile({ lineCount }),
    };
  });
}

export function diffSummary(diff: WorkspaceDiffResponse | null | undefined): DiffSummaryViewModel {
  const stats = diff?.stats;
  const fileCount = stats?.fileCount ?? 0;
  const additions = stats?.additions ?? 0;
  const deletions = stats?.deletions ?? 0;
  const warningCount = diff?.warnings.length ?? 0;

  return {
    changedLabel: `${fileCount} ${fileCount === 1 ? "file" : "files"}`,
    lineLabel: `+${additions} / -${deletions}`,
    warningCount,
    truncated: Boolean(diff?.truncated),
  };
}

export function nextExpandedFileSet(
  current: ReadonlySet<string>,
  filePath: string,
): Set<string> {
  const next = new Set(current);
  if (next.has(filePath)) next.delete(filePath);
  else next.add(filePath);
  return next;
}

export function initialExpandedFileSet(files: readonly DiffFileViewModel[]): Set<string> {
  return new Set(files.filter((file) => !file.longDiff).map((file) => file.path));
}
