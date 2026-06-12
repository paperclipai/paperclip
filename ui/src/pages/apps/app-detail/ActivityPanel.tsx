import { useMemo } from "react";
import type { Agent, ToolCallEvent } from "@paperclipai/shared";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/timeAgo";
import type { ActivityPanelProps } from "./types";

export function ActivityPanel({ events, loading, agents }: ActivityPanelProps) {
  return <RecentActivity events={events} loading={loading} agents={agents} />;
}

function RecentActivity({
  events,
  loading,
  agents,
}: {
  events: ToolCallEvent[];
  loading: boolean;
  agents: Agent[];
}) {
  const nameById = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents]);
  const visible = events.filter((e) => HUMANIZED_EVENTS.has(e.eventType));

  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-bold text-foreground">Recent activity</h2>
      </div>
      {loading ? (
        <div className="space-y-2 p-5">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : visible.length === 0 ? (
        <p className="px-5 py-5 text-sm text-muted-foreground">No activity yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {visible.map((event) => (
            <li key={event.id} className="flex items-start gap-3 px-5 py-3 text-sm">
              <span
                className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", dotColor(event))}
                aria-hidden
              />
              <span className="flex-1 text-foreground">
                {humanizeEvent(event, nameById.get(event.agentId ?? "") ?? null)}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(event.createdAt)}</span>
            </li>
          ))}
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

function humanizeEvent(event: ToolCallEvent, agentName: string | null): string {
  const who = agentName ?? "An agent";
  const action = event.toolName ?? "an action";
  switch (event.eventType) {
    case "call_completed":
      return event.outcome === "success"
        ? `${who} used ${action}.`
        : `${who} ran ${action}, but it didn't finish.`;
    case "call_failed":
      return `${action} didn't work for ${lower(who)}.`;
    case "call_denied":
      return `Blocked ${action} - it isn't turned on.`;
    case "approval_requested":
      return `${who} asked before running ${action}.`;
    case "approval_resolved":
      return `You reviewed ${action}.`;
    default:
      return `${who} used ${action}.`;
  }
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
