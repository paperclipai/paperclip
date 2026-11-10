import type {
  TaskChatDiffLine,
  TaskChatItem,
  TaskChatToolItem,
  TaskChatWorkspaceChangeItem,
} from "./task-chat-model";

type ChangeFile = TaskChatWorkspaceChangeItem["files"][number];

function patchLine(line: TaskChatDiffLine): string {
  if (line.kind === "hunk") return line.text;
  if (line.kind === "add") return `+${line.text}`;
  if (line.kind === "remove") return `-${line.text}`;
  return ` ${line.text}`;
}

interface EditFile {
  path: string;
  lines: TaskChatDiffLine[];
  additions: number;
  deletions: number;
  truncated: boolean;
}

/**
 * Split one edit row's diff into per-file patches (`file` lines start the next
 * file). Producer counts, when present, cover patches that were shortened.
 */
function editFiles(tool: TaskChatToolItem): EditFile[] {
  const diff = tool.diff;
  if (!diff?.lines?.length && !diff?.files?.length) return [];
  const chunks: Array<{ path: string; lines: TaskChatDiffLine[] }> = [];
  let current = { path: diff.path ?? tool.target ?? "", lines: [] as TaskChatDiffLine[] };
  for (const line of diff.lines ?? []) {
    if (line.kind === "file") {
      if (current.path) chunks.push(current);
      current = { path: line.text, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.path) chunks.push(current);
  return chunks.map((chunk, index) => {
    const reported = diff.files?.[index];
    const counted = {
      additions: chunk.lines.filter((line) => line.kind === "add").length,
      deletions: chunk.lines.filter((line) => line.kind === "remove").length,
    };
    return {
      ...chunk,
      additions: reported?.additions ?? counted.additions,
      deletions: reported?.deletions ?? counted.deletions,
      truncated: reported?.truncated ?? (diff.truncated === true && index === chunks.length - 1),
    };
  });
}

/**
 * The turn's changed files, assembled from its edit rows. Used when the
 * harness reports only per-edit patches (Claude) and no whole-turn diff, so
 * every turn that edited files ends with the same card.
 */
export function turnChangesFromEditRows(
  items: readonly TaskChatItem[],
  runId: string,
  complete: boolean,
): TaskChatWorkspaceChangeItem | null {
  const byPath = new Map<string, { patches: string[]; additions: number; deletions: number; created: boolean; truncated: boolean }>();
  for (const item of items) {
    // A failed or interrupted call may carry the patch it proposed before it
    // ran; only edits that ran (or are still running) count as changes.
    if (item.kind !== "tool" || item.status === "failed" || item.status === "interrupted") continue;
    for (const file of editFiles(item)) {
      const entry = byPath.get(file.path) ?? { patches: [], additions: 0, deletions: 0, created: true, truncated: false };
      if (file.lines.length) entry.patches.push(file.lines.map(patchLine).join("\n"));
      entry.additions += file.additions;
      entry.deletions += file.deletions;
      entry.truncated ||= file.truncated;
      // A file is new only when its first edit added lines to nothing.
      if (byPath.has(file.path) === false) {
        const hunks = file.lines.filter((line) => line.kind === "hunk");
        entry.created = hunks.length > 0
          && hunks.every((line) => /^@@ -0,0 /.test(line.text))
          && file.lines.every((line) => line.kind === "add" || line.kind === "hunk");
      }
      byPath.set(file.path, entry);
    }
  }
  if (byPath.size === 0) return null;
  const files: ChangeFile[] = [...byPath.entries()].map(([path, entry]) => ({
    path,
    operation: entry.created ? "create" : "modify",
    previousPath: null,
    // Every line removed from a file this turn created was added earlier in
    // the turn, so its net size is exact; edits to existing files are summed.
    additions: entry.created ? Math.max(entry.additions - entry.deletions, 0) : entry.additions,
    deletions: entry.created ? 0 : entry.deletions,
    binary: false,
    diff: entry.patches.length ? `${entry.patches.join("\n")}\n` : null,
    diffTruncated: entry.truncated,
  }));
  return {
    id: `${runId}:workspace:edits`,
    kind: "protocol",
    surface: "workspace_change",
    changeSetId: `${runId}:edits`,
    revision: 1,
    source: "harness_reported",
    complete,
    files,
    totals: {
      files: files.length,
      additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
      deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
    },
    patchArtifactRef: null,
  };
}
