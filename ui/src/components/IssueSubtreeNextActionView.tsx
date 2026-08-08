import { Ban, CircleDot, LifeBuoy, Play } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { IssueSubtreeDiagnosticsResponse } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import {
  deriveSubtreeNodeBadge,
  selectActionableLeafNodeId,
  type NextActionAccent,
  type NextActionLane,
} from "../lib/next-action";

/** Left-accent hue per lane. All values are tokens — never raw color literals. */
const ACCENT_VAR: Record<NextActionAccent, string> = {
  in_progress: "var(--status-task-in_progress)",
  in_review: "var(--status-task-in_review)",
  todo: "var(--status-task-todo)",
  blocked: "var(--status-task-blocked)",
  recovery_amber: "var(--status-task-todo)",
  recovery_sky: "var(--status-task-in_progress)",
  recovery_red: "var(--status-task-blocked)",
  none: "var(--muted-foreground)",
};

const LANE_ICON: Record<NextActionLane, LucideIcon> = {
  working_now: Play,
  recovery: LifeBuoy,
  waiting_decision: CircleDot,
  blocked_real_work: Ban,
  none: CircleDot,
};

export interface IssueSubtreeNextActionViewProps {
  data: IssueSubtreeDiagnosticsResponse;
  className?: string;
}

/**
 * Subtree diagnostics — the same next-action resolver, one compact line per
 * node. The operator scans the tree to find where work
 * moves next without opening every child; the single actionable leaf is
 * highlighted so it reads at a glance (Information Scent / F-pattern).
 */
export function IssueSubtreeNextActionView({ data, className }: IssueSubtreeNextActionViewProps) {
  const actionableLeafId = selectActionableLeafNodeId(data.nodes);

  if (data.nodes.length === 0) return null;

  return (
    <div
      data-testid="issue-subtree-next-action"
      className={`rounded-md border border-border bg-card text-card-foreground ${className ?? ""}`}
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
          Blocker map · next action per node
        </span>
        <span className="font-mono text-(length:--text-nano) text-muted-foreground">
          {data.nodeCount} node{data.nodeCount === 1 ? "" : "s"}
          {data.truncated ? " · truncated" : ""}
        </span>
      </div>

      <ul className="divide-y divide-border/60">
        {data.nodes.map((node) => {
          const badge = deriveSubtreeNodeBadge(node);
          const accent = ACCENT_VAR[badge.accent];
          const Icon = LANE_ICON[badge.lane];
          const isActionable = node.issue.id === actionableLeafId;
          const issuePathId = node.issue.identifier ?? node.issue.id;
          const targetPathId = badge.target
            ? badge.target.identifier ?? badge.target.id
            : null;
          return (
            <li
              key={node.issue.id}
              data-testid="issue-subtree-node"
              data-node-lane={badge.lane}
              data-actionable-leaf={isActionable ? "true" : undefined}
              className="flex items-center gap-2 px-3 py-2"
              style={
                isActionable
                  ? {
                    backgroundColor: "var(--surface-next-action-marker)",
                    boxShadow: "var(--shadow-next-action-marker)",
                  }
                  : undefined
              }
            >
              {/* Depth indentation so the parent→child shape reads. */}
              <span
                aria-hidden
                style={{ width: `calc(var(--sz-12px) * ${Math.min(node.depth, 6)})` }}
                className="shrink-0"
              />

              {/* Node identity */}
              <Link
                to={createIssueDetailPath(issuePathId)}
                className="inline-flex min-w-0 items-center gap-1.5 font-mono text-xs text-foreground hover:underline"
              >
                <span className="shrink-0">{node.issue.identifier ?? node.issue.id.slice(0, 8)}</span>
                <span className="truncate font-sans text-(length:--text-micro) text-muted-foreground">
                  {node.issue.title}
                </span>
              </Link>

              <span className="ml-auto flex shrink-0 items-center gap-1.5">
                {isActionable ? (
                  <span
                    className="rounded-sm px-1 py-0.5 text-(length:--text-nano) font-semibold uppercase tracking-wide"
                    style={{
                      color: "var(--status-task-todo)",
                      backgroundColor: "var(--surface-next-action-chip)",
                    }}
                  >
                    Act here
                  </span>
                ) : null}

                {/* Compact lane badge */}
                <span
                  className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-(length:--text-nano) font-medium"
                  style={{ borderColor: accent, color: accent }}
                >
                  <Icon className="h-3 w-3" aria-hidden />
                  {targetPathId ? (
                    <Link
                      to={createIssueDetailPath(targetPathId)}
                      className="font-mono hover:underline"
                      style={{ color: accent }}
                    >
                      {badge.statement}
                    </Link>
                  ) : (
                    <span className="font-mono">{badge.statement}</span>
                  )}
                </span>

                {badge.gate ? (
                  <span className="inline-flex items-center rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-(length:--text-nano) text-muted-foreground">
                    {badge.gate}
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
