import { useEffect, useMemo, useState } from "react";
import type { ActivityEvent } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn, relativeTime } from "@/lib/utils";

export type IssueActivityTimelineItem = ActivityEvent;

type AgentNameMap = Map<string, string> | Record<string, string | undefined> | null | undefined;

function humanize(value: unknown): string {
  if (typeof value !== "string") return String(value ?? "none");
  return value.replace(/_/g, " ");
}

function titleize(value: string) {
  return value
    .split(/[._-]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function displayActionTitle(action: string) {
  const parts = action.split(/[._-]/g).filter(Boolean);
  if (parts.length === 0) return "Activity";
  return `${parts[0].charAt(0).toUpperCase() + parts[0].slice(1)} ${parts.slice(1).join(" ")}`;
}

function actionChipLabel(action: string) {
  if (action.startsWith("issue.")) return "Issue";
  if (action.startsWith("agent.")) return "Agent";
  if (action.startsWith("heartbeat.")) return "Heartbeat";
  if (action.startsWith("approval.")) return "Approval";
  if (action.startsWith("cost.")) return "Cost";
  if (action.startsWith("finance_event.")) return "Finance";
  return titleize(action.split(".")[0] ?? action);
}

function payloadChipLabels(details: Record<string, unknown> | null) {
  const labels: string[] = [];
  if (details && typeof details.command === "string" && details.command.trim()) labels.push("Command");
  if (details && typeof details.exitCode === "number") labels.push("Test");
  if (details && typeof details.commit === "string") labels.push("Commit");
  return labels;
}

function actionSummary(action: string, details: Record<string, unknown> | null) {
  if (action === "issue.updated" && details) {
    const previous = (details._previous ?? {}) as Record<string, unknown>;
    const parts: string[] = [];

    if (details.status !== undefined) {
      const from = previous.status;
      parts.push(
        from
          ? `changed the status from ${humanize(from)} to ${humanize(details.status)}`
          : `changed the status to ${humanize(details.status)}`,
      );
    }
    if (details.priority !== undefined) {
      const from = previous.priority;
      parts.push(
        from
          ? `changed the priority from ${humanize(from)} to ${humanize(details.priority)}`
          : `changed the priority to ${humanize(details.priority)}`,
      );
    }
    if (details.assigneeAgentId !== undefined || details.assigneeUserId !== undefined) {
      parts.push(details.assigneeAgentId || details.assigneeUserId ? "assigned the issue" : "unassigned the issue");
    }
    if (details.title !== undefined) parts.push("updated the title");
    if (details.description !== undefined) parts.push("updated the description");

    if (parts.length > 0) return parts.join(", ");
  }

  if (action === "issue.document_created" || action === "issue.document_updated" || action === "issue.document_deleted") {
    const key = typeof details?.key === "string" ? details.key : "document";
    const title = typeof details?.title === "string" && details.title ? ` (${details.title})` : "";
    return `${titleize(action.split(".")[1] ?? action)} ${key}${title}`;
  }

  return titleize(action.replace(/[._]/g, " "));
}

function actorLabel(event: ActivityEvent, agentNames: AgentNameMap) {
  if (event.actorType === "system") return "System";
  if (event.actorType === "user") return "Board";
  if (event.actorType === "agent") {
    const maybeName =
      agentNames instanceof Map
        ? agentNames.get(event.actorId)
        : agentNames?.[event.actorId];
    return maybeName ?? event.actorId.slice(0, 8);
  }
  return event.actorId.slice(0, 8);
}

function prettyJson(value: Record<string, unknown> | null) {
  if (!value) return "{ }";
  return JSON.stringify(value, null, 2);
}

function parseEventDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export function IssueActivityTimeline({
  items,
  agentNames,
}: {
  items: IssueActivityTimelineItem[];
  agentNames?: AgentNameMap;
}) {
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedItemId) return;
    if (!items.some((item) => item.id === selectedItemId)) {
      setSelectedItemId(null);
    }
  }, [items, selectedItemId]);

  const selectedItem = useMemo(
    () => items.find((item) => item.id === selectedItemId) ?? null,
    [items, selectedItemId],
  );
  const selectedCreatedAt = selectedItem ? parseEventDate(selectedItem.createdAt) : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Activity</h3>
          <p className="text-xs text-muted-foreground">Chronological events with payload drilldown.</p>
        </div>
        {items.length > 0 ? (
          <Badge variant="outline" className="text-muted-foreground">
            {items.length} events
          </Badge>
        ) : null}
      </div>

      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">No activity yet.</p>
      ) : (
        <div className="space-y-2">
          {items.map((item) => {
            const isSelected = item.id === selectedItemId;
            const summary = actionSummary(item.action, item.details);
            const chip = actionChipLabel(item.action);
            const payloadChips = payloadChipLabels(item.details);
            const createdAt = parseEventDate(item.createdAt);

            return (
              <Button
                key={item.id}
                type="button"
                variant="ghost"
                data-activity-item={item.id}
                onClick={() => setSelectedItemId(item.id)}
                className={cn(
                  "h-auto w-full justify-start rounded-lg border border-border px-3 py-3 text-left hover:bg-accent/20",
                  isSelected && "border-foreground/20 bg-accent/25",
                )}
              >
                <div className="flex w-full items-start gap-3">
                  <div className="mt-0.5 flex shrink-0 flex-wrap gap-1">
                    <Badge variant="outline" className="rounded-full">
                      {chip}
                    </Badge>
                    {payloadChips.map((label) => (
                      <Badge key={label} variant="secondary" className="rounded-full">
                        {label}
                      </Badge>
                    ))}
                  </div>

                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                      <span className="font-medium text-foreground">{displayActionTitle(item.action)}</span>
                      <span className="text-muted-foreground">by {actorLabel(item, agentNames)}</span>
                    </div>
                    <p className="text-xs text-muted-foreground">{summary}</p>
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span>{titleize(item.entityType)}</span>
                      <span>•</span>
                      <time dateTime={createdAt.toISOString()}>{relativeTime(createdAt)}</time>
                    </div>
                  </div>
                </div>
              </Button>
            );
          })}
        </div>
      )}

      <Sheet open={Boolean(selectedItemId)} onOpenChange={(open) => !open && setSelectedItemId(null)}>
        <SheetContent side="right" className="w-full sm:max-w-lg">
          {selectedItem ? (
            <>
              <SheetHeader>
                <SheetTitle>{displayActionTitle(selectedItem.action)}</SheetTitle>
                <SheetDescription>
                  {actionChipLabel(selectedItem.action)} event by {actorLabel(selectedItem, agentNames)} at {selectedCreatedAt?.toLocaleString()}
                </SheetDescription>
              </SheetHeader>

              <div className="space-y-4 px-4 pb-4">
                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline">{actionChipLabel(selectedItem.action)}</Badge>
                  {payloadChipLabels(selectedItem.details).map((label) => (
                    <Badge key={label} variant="secondary">
                      {label}
                    </Badge>
                  ))}
                  {selectedItem.runId ? <Badge variant="secondary">Run {selectedItem.runId.slice(0, 8)}</Badge> : null}
                </div>

                <section className="space-y-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Summary</h4>
                  <p className="text-sm text-foreground">{actionSummary(selectedItem.action, selectedItem.details)}</p>
                </section>

                <section className="space-y-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Payload</h4>
                  <pre className="max-h-[50vh] overflow-auto rounded-lg border border-border bg-muted/30 p-3 text-xs leading-5 text-foreground">
                    {prettyJson(selectedItem.details)}
                  </pre>
                </section>
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
