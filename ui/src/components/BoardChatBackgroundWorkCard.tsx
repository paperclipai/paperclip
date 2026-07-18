import type { Agent, IssueRelationIssueSummary } from "@paperclipai/shared";
import { Paperclip } from "lucide-react";
import { Link } from "@/lib/router";
import { cn } from "../lib/utils";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import { IssueLinkQuicklook } from "./IssueLinkQuicklook";
import { SystemNotice } from "./SystemNotice";

type BackgroundWorkStatus = {
  label: string;
  className: string;
  actionLabel?: string;
};

function backgroundWorkStatus(issue: IssueRelationIssueSummary): BackgroundWorkStatus {
  switch (issue.status) {
    case "done":
      return {
        label: "Done",
        className:
          "border-emerald-300/70 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-200",
      };
    case "in_review":
      return {
        label: "Needs your input",
        className:
          "border-amber-300/80 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-100",
        actionLabel: "Review the question ->",
      };
    case "blocked":
      return {
        label: "Waiting on linked work",
        className:
          "border-sky-300/70 bg-sky-50 text-sky-800 dark:border-sky-500/40 dark:bg-sky-500/15 dark:text-sky-200",
      };
    case "cancelled":
      return {
        label: "Couldn't finish",
        className:
          "border-red-300/70 bg-red-50 text-red-800 dark:border-red-500/40 dark:bg-red-500/15 dark:text-red-200",
        actionLabel: "Open task to retry or hand off ->",
      };
    default:
      return {
        label: "Working",
        className:
          "border-blue-300/70 bg-blue-50 text-blue-800 dark:border-blue-500/40 dark:bg-blue-500/15 dark:text-blue-200",
      };
  }
}

function helperText(children: readonly IssueRelationIssueSummary[]) {
  const openCount = children.filter((child) => child.status !== "done" && child.status !== "cancelled").length;
  if (openCount === 0) return "All set. Tap a task to see what shipped.";
  if (children.length === 1) return "I'll let you know here when it's done.";
  if (children.length <= 3) return "I'll let you know here as each piece finishes.";
  return "I'll keep you posted here as pieces finish.";
}

function assigneeLabel(issue: IssueRelationIssueSummary, agentMap?: Map<string, Agent>) {
  if (!issue.assigneeAgentId) return null;
  const agent = agentMap?.get(issue.assigneeAgentId);
  if (!agent) return "Assigned agent";
  return [agent.name, agent.role.toUpperCase()].filter(Boolean).join(" · ");
}

export function BoardChatBackgroundWorkCard({
  childrenIssues,
  agentMap,
}: {
  childrenIssues: readonly IssueRelationIssueSummary[];
  agentMap?: Map<string, Agent>;
}) {
  if (childrenIssues.length === 0) return null;

  return (
    <SystemNotice
      tone="info"
      label="Working on this in the background"
      iconOverride={Paperclip}
      className="mb-3"
      body={
        <div className="space-y-2.5">
          <p className="text-xs leading-5 text-muted-foreground">
            {helperText(childrenIssues)}
          </p>
          <div className="border-t border-sky-300/50 pt-2 dark:border-sky-500/30">
            <div className="space-y-1.5">
              {childrenIssues.map((child) => {
                const issuePathId = child.identifier ?? child.id;
                const status = backgroundWorkStatus(child);
                const assignee = assigneeLabel(child, agentMap);
                return (
                  <div
                    key={child.id}
                    className="rounded-md border border-sky-200/70 bg-background/70 px-2.5 py-2 dark:border-sky-500/20 dark:bg-background/40"
                  >
                    <div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                      <IssueLinkQuicklook
                        issuePathId={issuePathId}
                        to={createIssueDetailPath(issuePathId)}
                        className="inline-flex min-w-0 items-center gap-1 rounded-sm font-mono text-xs font-medium text-sky-900 underline-offset-2 hover:underline dark:text-sky-100"
                      >
                        <span className="shrink-0">{child.identifier ?? child.id.slice(0, 8)}</span>
                        <span className="max-w-(--sz-18rem) truncate font-sans text-(length:--text-micro) font-normal text-muted-foreground">
                          {child.title}
                        </span>
                      </IssueLinkQuicklook>
                      <span
                        className={cn(
                          "inline-flex w-fit shrink-0 items-center rounded-full border px-2 py-0.5 text-(length:--text-micro) font-medium",
                          status.className,
                        )}
                      >
                        {status.label}
                      </span>
                    </div>
                    {assignee || status.actionLabel ? (
                      <div className="mt-1 flex min-w-0 flex-col gap-1 text-(length:--text-micro) text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                        {assignee ? <span className="truncate">{assignee}</span> : <span />}
                        {status.actionLabel ? (
                          <Link
                            to={createIssueDetailPath(issuePathId)}
                            className="w-fit text-sky-700 underline-offset-2 hover:underline dark:text-sky-200"
                          >
                            {status.actionLabel}
                          </Link>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      }
    />
  );
}
