import type { RecentIssue } from "@paperclipai/shared";
import { Clock3 } from "lucide-react";
import { useMemo, useState, type CSSProperties } from "react";
import { Link } from "@/lib/router";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarSection } from "./SidebarSection";
import { timeAgo } from "../lib/timeAgo";
import { useSidebar } from "../context/SidebarContext";

const VISIBLE_RECENT_ISSUES = 10;
const TERMINAL_STATUSES = new Set(["done", "cancelled"]);

const INTERACTION_LABELS: Record<RecentIssue["kind"], string> = {
  created: "You created",
  commented: "You commented",
  interaction: "You responded",
  approval: "You decided",
  edited: "You edited",
  document: "You edited a document",
};

function issueHref(issue: RecentIssue): string {
  if (issue.needsAttention && issue.attentionHref) return issue.attentionHref;
  return `/issues/${issue.identifier ?? issue.id}`;
}

function statusLabel(status: string): string {
  return status.replaceAll("_", " ");
}

export interface SidebarRecentIssuesProps {
  issues: RecentIssue[];
  liveIssueIds?: ReadonlySet<string>;
}

export function SidebarRecentIssues({ issues, liveIssueIds }: SidebarRecentIssuesProps) {
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const { collapsed, peeking } = useSidebar();
  const rail = collapsed && !peeking;
  // Keep server order as the sole row-order source. Decorations are derived
  // separately so a live or attention transition cannot move a row.
  const visibleIssues = useMemo(
    () => issues.slice(0, expanded ? 25 : VISIBLE_RECENT_ISSUES),
    [expanded, issues],
  );
  const hasAttention = useMemo(
    () => issues.some((issue) => issue.needsAttention),
    [issues],
  );

  if (visibleIssues.length === 0) return null;

  if (rail) {
    return (
      <SidebarSection label="Recent">
        <SidebarNavItem
          to="/issues?touchedByUserId=me&sortField=last_interaction&sortDir=desc"
          label="Recent"
          icon={Clock3}
          badge={hasAttention ? 1 : undefined}
          badgeLabel="task needs you"
          badgeTone="warning"
        />
      </SidebarSection>
    );
  }

  return (
    <SidebarSection label="Recent" collapsible={{ open, onOpenChange: setOpen }}>
      {visibleIssues.map((issue) => {
        const needsAttention = issue.needsAttention;
        const isLive = liveIssueIds ? liveIssueIds.has(issue.id) : issue.hasActiveRun;
        const attentionReason = needsAttention ? "Decision requested" : null;
        const interaction = `${INTERACTION_LABELS[issue.kind]} · ${timeAgo(issue.lastInteractedAt)}`;
        const status = statusLabel(issue.status);
        const tooltip = [issue.identifier, issue.title, `Status: ${status}`, attentionReason, isLive ? "Live run" : null, interaction]
          .filter(Boolean)
          .join("\n");

        return (
          <SidebarNavItem
            key={issue.id}
            to={issueHref(issue)}
            label={issue.title}
            iconNode={(
              <span
                className="block size-2 rounded-full bg-(--recent-issue-status-color)"
                style={{ "--recent-issue-status-color": `var(--status-task-icon-${issue.status})` } as CSSProperties}
                aria-hidden="true"
              />
            )}
            className="min-w-0"
            labelClassName={TERMINAL_STATUSES.has(issue.status) ? "text-muted-foreground" : undefined}
            trailingLabel={[needsAttention ? "Needs you" : null, isLive ? "Live run" : null].filter(Boolean).join(", ")}
            tooltip={tooltip}
            trailing={(
              <span className="flex shrink-0 items-center gap-1" aria-label={[needsAttention ? "Needs you" : null, isLive ? "Live run" : null].filter(Boolean).join(", ") || undefined}>
                {needsAttention ? (
                  <span className="rounded-full bg-(--recent-attention-bg) px-1.5 py-0.5 text-(length:--text-nano) font-medium leading-none text-(--recent-attention-fg)">
                    Needs you
                  </span>
                ) : null}
                {isLive ? (
                  <span className="flex items-center text-(--status-task-icon-done)" aria-label="Live run" title="Live run">
                    <span className="relative flex size-2" aria-hidden="true">
                      <span className="absolute inline-flex size-full animate-ping rounded-full bg-(--status-task-done) opacity-75 motion-reduce:animate-none" />
                      <span className="relative inline-flex size-2 rounded-full bg-(--status-task-icon-done)" />
                    </span>
                  </span>
                ) : null}
              </span>
            )}
          />
        );
      })}
      {issues.length > VISIBLE_RECENT_ISSUES ? (
        <button
          type="button"
          className="mx-2 rounded-md px-2 py-1 text-left text-(length:--text-nano) font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show fewer" : "Show more…"}
        </button>
      ) : null}
      {expanded ? (
        <Link
          to="/issues?touchedByUserId=me&sortField=last_interaction&sortDir=desc"
          className="mx-2 rounded-md px-2 py-1 text-(length:--text-nano) font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        >
          All my activity →
        </Link>
      ) : null}
    </SidebarSection>
  );
}
