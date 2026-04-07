import { useState, useMemo } from "react";
import type { Issue } from "@paperclipai/shared";
import type { IssueDependencyRecord } from "../api/issues";
import { Link } from "@/lib/router";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import { cn } from "../lib/utils";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";
import { Identity } from "./Identity";
import { ChevronRight, Ban, CheckCircle2 } from "lucide-react";

/* ── Types ── */

interface IssueTreeProps {
  issues: Issue[];
  /** Map of issueId -> dependencies (what blocks it) */
  dependenciesByIssue?: Map<string, IssueDependencyRecord[]>;
  agents?: { id: string; name: string }[];
  issueLinkState?: unknown;
  /** Only show subtree rooted at this issue id (omit for full tree) */
  rootId?: string;
  onStatusChange?: (issueId: string, status: string) => void;
}

interface IssueNodeProps {
  issue: Issue;
  allIssues: Issue[];
  childrenByParent: Map<string, Issue[]>;
  dependenciesByIssue: Map<string, IssueDependencyRecord[]>;
  agentMap: Map<string, string>;
  depth: number;
  issueLinkState?: unknown;
  onStatusChange?: (issueId: string, status: string) => void;
}

/* ── Progress helper ── */

function childProgress(issue: Issue, childrenByParent: Map<string, Issue[]>): { done: number; total: number } | null {
  const children = childrenByParent.get(issue.id);
  if (!children || children.length === 0) return null;
  const done = children.filter((c) => c.status === "done" || c.status === "cancelled").length;
  return { done, total: children.length };
}

/* ── Dependency badge ── */

function DependencyBadges({ deps }: { deps: IssueDependencyRecord[] }) {
  if (deps.length === 0) return null;
  const pending = deps.filter((d) => d.blockedByIssue.status !== "done" && d.blockedByIssue.status !== "cancelled");
  const resolved = deps.length - pending.length;

  if (pending.length === 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-1.5 py-0.5 text-[10px] font-medium text-green-600 dark:text-green-400">
        <CheckCircle2 className="h-3 w-3" />
        {resolved} dep{resolved !== 1 ? "s" : ""} resolved
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-orange-500/10 px-1.5 py-0.5 text-[10px] font-medium text-orange-600 dark:text-orange-400">
      <Ban className="h-3 w-3" />
      blocked by {pending.map((d) => d.blockedByIssue.identifier ?? d.blockedByIssue.id.slice(0, 6)).join(", ")}
    </span>
  );
}

/* ── Progress bar ── */

function ProgressIndicator({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground">
      <span className="relative h-1.5 w-12 overflow-hidden rounded-full bg-muted">
        <span
          className={cn(
            "absolute left-0 top-0 h-full rounded-full transition-all",
            pct === 100 ? "bg-green-500" : "bg-blue-500",
          )}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="tabular-nums">{done}/{total}</span>
    </span>
  );
}

/* ── Tree node ── */

function IssueNode({
  issue,
  allIssues,
  childrenByParent,
  dependenciesByIssue,
  agentMap,
  depth,
  issueLinkState,
  onStatusChange,
}: IssueNodeProps) {
  const [expanded, setExpanded] = useState(true);
  const children = childrenByParent.get(issue.id) ?? [];
  const hasChildren = children.length > 0;
  const deps = dependenciesByIssue.get(issue.id) ?? [];
  const progress = childProgress(issue, childrenByParent);
  const identifier = issue.identifier ?? issue.id.slice(0, 8);
  const agentName = issue.assigneeAgentId ? agentMap.get(issue.assigneeAgentId) : null;

  return (
    <div>
      <Link
        to={createIssueDetailPath(identifier, issueLinkState)}
        state={issueLinkState}
        className="group flex items-center gap-2 py-1.5 pr-3 text-sm no-underline text-inherit transition-colors hover:bg-accent/50"
        style={{ paddingLeft: `${depth * 20 + 8}px` }}
      >
        {/* Expand/collapse toggle */}
        {hasChildren ? (
          <button
            className="shrink-0 p-0.5"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setExpanded(!expanded);
            }}
          >
            <ChevronRight
              className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", expanded && "rotate-90")}
            />
          </button>
        ) : (
          <span className="w-[18px] shrink-0" />
        )}

        {/* Status icon */}
        <span
          className="shrink-0"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <StatusIcon
            status={issue.status}
            onChange={onStatusChange ? (s) => onStatusChange(issue.id, s) : undefined}
          />
        </span>

        {/* Identifier */}
        <span className="shrink-0 font-mono text-xs text-muted-foreground">{identifier}</span>

        {/* Title */}
        <span className="min-w-0 flex-1 truncate">{issue.title}</span>

        {/* Dependency badges */}
        <span className="hidden items-center gap-1.5 sm:flex">
          {deps.length > 0 && <DependencyBadges deps={deps} />}
        </span>

        {/* Progress indicator */}
        {progress && (
          <span className="hidden sm:inline-flex">
            <ProgressIndicator done={progress.done} total={progress.total} />
          </span>
        )}

        {/* Priority */}
        <span className="hidden shrink-0 sm:inline-flex">
          <PriorityIcon priority={issue.priority} />
        </span>

        {/* Assignee */}
        {agentName && (
          <span className="hidden shrink-0 sm:inline-flex">
            <Identity name={agentName} size="sm" />
          </span>
        )}
      </Link>

      {/* Render children */}
      {hasChildren && expanded && (
        <div>
          {children.map((child) => (
            <IssueNode
              key={child.id}
              issue={child}
              allIssues={allIssues}
              childrenByParent={childrenByParent}
              dependenciesByIssue={dependenciesByIssue}
              agentMap={agentMap}
              depth={depth + 1}
              issueLinkState={issueLinkState}
              onStatusChange={onStatusChange}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Main component ── */

export function IssueTree({
  issues,
  dependenciesByIssue = new Map(),
  agents,
  issueLinkState,
  rootId,
  onStatusChange,
}: IssueTreeProps) {
  const issueIds = useMemo(() => new Set(issues.map((i) => i.id)), [issues]);

  const childrenByParent = useMemo(() => {
    const map = new Map<string, Issue[]>();
    for (const issue of issues) {
      if (!issue.parentId || !issueIds.has(issue.parentId)) continue;
      const siblings = map.get(issue.parentId) ?? [];
      siblings.push(issue);
      map.set(issue.parentId, siblings);
    }
    // Sort children by createdAt within each parent
    for (const [, children] of map) {
      children.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    }
    return map;
  }, [issues, issueIds]);

  const roots = useMemo(() => {
    if (rootId) {
      // Show only children of the specified root
      return (childrenByParent.get(rootId) ?? []);
    }
    // Find top-level issues (no parent or parent not in set)
    return issues.filter((i) => !i.parentId || !issueIds.has(i.parentId));
  }, [issues, issueIds, rootId, childrenByParent]);

  const agentMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const agent of agents ?? []) {
      m.set(agent.id, agent.name);
    }
    return m;
  }, [agents]);

  if (roots.length === 0) {
    return <p className="text-sm text-muted-foreground py-2">No issues to display.</p>;
  }

  return (
    <div className="border border-border rounded-lg py-1">
      {roots.map((issue) => (
        <IssueNode
          key={issue.id}
          issue={issue}
          allIssues={issues}
          childrenByParent={childrenByParent}
          dependenciesByIssue={dependenciesByIssue}
          agentMap={agentMap}
          depth={0}
          issueLinkState={issueLinkState}
          onStatusChange={onStatusChange}
        />
      ))}
    </div>
  );
}
