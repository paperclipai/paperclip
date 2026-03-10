import { Link } from "@/lib/router";
import { StatusIcon } from "./StatusIcon";
import type { Issue } from "@paperclipai/shared";

/* ── Subtask count helpers ── */

export interface SubtaskCounts {
  total: number;
  done: number;
}

export function buildSubtaskCountMap(issues: Issue[]): Map<string, SubtaskCounts> {
  const map = new Map<string, SubtaskCounts>();
  for (const issue of issues) {
    if (!issue.parentId) continue;
    const existing = map.get(issue.parentId) ?? { total: 0, done: 0 };
    existing.total += 1;
    if (issue.status === "done" || issue.status === "cancelled") {
      existing.done += 1;
    }
    map.set(issue.parentId, existing);
  }
  return map;
}

export function SubtaskBadge({ counts }: { counts: SubtaskCounts }) {
  if (counts.total === 0) return null;
  const allDone = counts.done === counts.total;
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border ${
        allDone
          ? "border-green-500/40 text-green-600 dark:text-green-400 bg-green-500/10"
          : "border-border text-muted-foreground bg-muted/40"
      }`}
      title={`${counts.done} of ${counts.total} subtasks done`}
    >
      <span className="leading-none">⊞</span>
      <span>{counts.done}/{counts.total}</span>
    </span>
  );
}

/* ── Inline subtask list (collapsed by default, shown under parent row) ── */

export function SubtaskList({
  subtasks,
  highlightIds,
}: {
  subtasks: Issue[];
  highlightIds?: Set<string>;
}) {
  if (subtasks.length === 0) return null;
  return (
    <div className="ml-6 border-l border-border pl-3 py-1 space-y-0.5">
      {subtasks.map((sub) => (
        <Link
          key={sub.id}
          to={`/issues/${sub.identifier ?? sub.id}`}
          className={`flex items-center gap-2 py-1 pr-2 text-xs rounded hover:bg-accent/50 no-underline text-inherit transition-colors ${
            highlightIds?.has(sub.id) ? "ring-1 ring-blue-500/50 bg-blue-500/5" : ""
          }`}
        >
          <StatusIcon status={sub.status} />
          <span
            className={`flex-1 truncate ${
              sub.status === "done" || sub.status === "cancelled"
                ? "line-through text-muted-foreground"
                : ""
            }`}
          >
            {sub.title}
          </span>
          <span className="text-muted-foreground font-mono shrink-0">
            {sub.identifier ?? sub.id.slice(0, 8)}
          </span>
        </Link>
      ))}
    </div>
  );
}
