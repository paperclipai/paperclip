import type { Issue } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { ChevronRight, GitBranch } from "lucide-react";
import { cn } from "../lib/utils";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";

type IssueLineageStripProps = {
  issue: Issue;
  childIssues?: Issue[];
  className?: string;
};

type LineageIssue = Pick<Issue, "id" | "identifier" | "title">;

function issueRef(issue: Pick<Issue, "identifier" | "id">) {
  return issue.identifier ?? issue.id;
}

function compactTitle(title: string) {
  return title.length > 72 ? `${title.slice(0, 69)}…` : title;
}

export function IssueLineageStrip({ issue, childIssues = [], className }: IssueLineageStripProps) {
  const ancestors: LineageIssue[] = [...(issue.ancestors ?? [])].reverse();
  const visibleChildren = childIssues.slice(0, 3);
  const remainingChildren = Math.max(0, childIssues.length - visibleChildren.length);

  if (ancestors.length === 0 && childIssues.length === 0) return null;

  return (
    <nav
      className={cn(
        "flex flex-wrap items-center gap-1 rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground",
        className,
      )}
      aria-label="Issue lineage"
    >
      <GitBranch className="h-3.5 w-3.5 shrink-0" />
      {ancestors.map((ancestor) => (
        <span key={ancestor.id} className="inline-flex min-w-0 items-center gap-1">
          <Link
            to={createIssueDetailPath(issueRef(ancestor))}
            className="max-w-[11rem] truncate rounded px-1 py-0.5 transition-colors hover:bg-accent hover:text-foreground"
            title={ancestor.title}
          >
            {ancestor.identifier ? `${ancestor.identifier} ` : ""}{compactTitle(ancestor.title)}
          </Link>
          <ChevronRight className="h-3 w-3 shrink-0" />
        </span>
      ))}
      <span className="min-w-0 max-w-[14rem] truncate rounded bg-background px-2 py-0.5 font-medium text-foreground" title={issue.title}>
        {issue.identifier ? `${issue.identifier} ` : ""}{compactTitle(issue.title)}
      </span>
      {visibleChildren.length > 0 ? <ChevronRight className="h-3 w-3 shrink-0" /> : null}
      {visibleChildren.map((child, index) => (
        <span key={child.id} className="inline-flex min-w-0 items-center gap-1">
          <Link
            to={createIssueDetailPath(issueRef(child))}
            className="max-w-[10rem] truncate rounded px-1 py-0.5 transition-colors hover:bg-accent hover:text-foreground"
            title={child.title}
          >
            {child.identifier ? `${child.identifier} ` : ""}{compactTitle(child.title)}
          </Link>
          {index < visibleChildren.length - 1 ? <span className="text-muted-foreground/70">/</span> : null}
        </span>
      ))}
      {remainingChildren > 0 ? (
        <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
          +{remainingChildren} downstream
        </span>
      ) : null}
    </nav>
  );
}
