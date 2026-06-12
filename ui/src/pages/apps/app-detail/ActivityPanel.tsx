import { useMemo } from "react";
import type { Agent, ToolCallEvent } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/timeAgo";
import type { ActivityPanelProps } from "./types";

export function ActivityPanel({ events, issues, actionRequests, loading, agents }: ActivityPanelProps) {
  return (
    <RecentActivity
      events={events}
      issues={issues}
      actionRequests={actionRequests}
      loading={loading}
      agents={agents}
    />
  );
}

function RecentActivity({
  events,
  issues,
  actionRequests,
  loading,
  agents,
}: {
  events: ToolCallEvent[];
  issues: ActivityPanelProps["issues"];
  actionRequests: ActivityPanelProps["actionRequests"];
  loading: boolean;
  agents: Agent[];
}) {
  const nameById = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents]);
  const visible = events.filter((e) => HUMANIZED_EVENTS.has(e.eventType));

  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-sm font-bold text-foreground">Recent activity</h2>
      </div>
      {loading ? (
        <div className="space-y-2 py-4">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : visible.length === 0 ? (
        <p className="py-5 text-sm text-muted-foreground">No activity yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {visible.map((event) => {
            const row = humanizeEvent(
              event,
              nameById.get(event.agentId ?? "") ?? null,
              event.actionRequestId ? actionRequests[event.actionRequestId] : undefined,
            );
            const issue = event.issueId ? issues[event.issueId] : undefined;
            return (
              <li key={event.id} className="flex items-start gap-3 py-3 text-sm">
                <span
                  className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", dotColor(event))}
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-foreground">{row.primary}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {issue ? (
                      <>
                        while working on{" "}
                        <Link to={`/issues/${issue.identifier}`} className="font-medium text-muted-foreground hover:text-foreground hover:underline">
                          {issue.identifier}
                        </Link>
                        {" · "}
                      </>
                    ) : null}
                    {timeAgo(event.createdAt)}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const HUMANIZED_EVENTS = new Set<ToolCallEvent["eventType"]>([
  "call_completed",
  "call_failed",
  "call_denied",
  "approval_requested",
  "approval_resolved",
]);

function humanizeEvent(
  event: ToolCallEvent,
  agentName: string | null,
  actionRequest?: ActivityPanelProps["actionRequests"][string],
): { primary: string } {
  const who = agentName ?? "An agent";
  const action = event.toolName ?? "an action";
  switch (event.eventType) {
    case "call_completed":
      return {
        primary: event.outcome === "success"
          ? `${who} used ${action}`
          : `${who} ran ${action}, but it didn't finish`,
      };
    case "call_failed":
      return { primary: `${action} didn't work for ${lower(who)}` };
    case "call_denied":
      return { primary: `Blocked ${action} - it isn't turned on` };
    case "approval_requested":
      return { primary: `${who} asked before running ${action}` };
    case "approval_resolved":
      return { primary: humanizeApprovalResolved(action, actionRequest) };
    default:
      return { primary: `${who} used ${action}` };
  }
}

function humanizeApprovalResolved(
  action: string,
  actionRequest?: ActivityPanelProps["actionRequests"][string],
): string {
  const resolver = actionRequest?.resolverDisplayName ?? "Someone";
  if (actionRequest?.status === "approved") return `${resolver} approved ${action}`;
  if (actionRequest?.status === "rejected") return `${resolver} said no to ${action}`;
  return `${resolver} reviewed ${action}`;
}

function lower(who: string): string {
  return who === "An agent" ? "an agent" : who;
}

function dotColor(event: ToolCallEvent): string {
  if (event.eventType === "call_failed" || event.outcome === "failure" || event.outcome === "timeout") {
    return "bg-red-400";
  }
  if (event.eventType === "call_denied" || event.outcome === "denied") return "bg-amber-400";
  if (event.eventType === "approval_requested") return "bg-amber-400";
  return "bg-emerald-400";
}
