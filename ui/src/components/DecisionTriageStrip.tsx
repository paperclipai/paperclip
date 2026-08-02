import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlarmClock, CalendarClock, ChevronDown, Loader2, Plus, UserPlus, X } from "lucide-react";
import { buildAgentMentionHref, type Agent, type AttentionItem, type AttentionSourceKind } from "@paperclipai/shared";
import { decisionQueuesApi } from "../api/decisionQueues";
import { issuesApi } from "../api/issues";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import {
  attentionTaskRef,
  DECIDE_BY_OPTIONS,
  decideByLabel,
  type DecideByPreset,
} from "../lib/attention";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Snooze presets shared with the row menu, resolved at click time. */
const SNOOZE_PRESETS: ReadonlyArray<{ label: string; resolve: () => string }> = [
  { label: "1 hour", resolve: () => new Date(Date.now() + HOUR_MS).toISOString() },
  { label: "4 hours", resolve: () => new Date(Date.now() + 4 * HOUR_MS).toISOString() },
  { label: "Tomorrow", resolve: () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d.toISOString();
  } },
  { label: "Next week", resolve: () => new Date(Date.now() + 7 * DAY_MS).toISOString() },
];

/** Slugify a queue title into a URL-safe kebab key the API will accept. */
function toQueueKey(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Compact countdown/overdue label for an expiry timestamp. */
function expiryLabel(expiresAt: string): { text: string; overdue: boolean } {
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(diff)) return { text: "", overdue: false };
  if (diff <= 0) return { text: "Expired", overdue: true };
  const mins = Math.round(diff / 60000);
  if (mins < 60) return { text: `Expires in ${mins}m`, overdue: false };
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return { text: `Expires in ${hrs}h`, overdue: false };
  const days = Math.round(hrs / 24);
  return { text: `Expires in ${days}d`, overdue: false };
}

interface DecisionTriageStripProps {
  item: AttentionItem;
  companyId: string;
  /** Company agents, for the route-to-agent picker (optional). */
  agents?: Agent[];
}

/**
 * Per-card triage strip (PAP-16032 §4.5 / wireframe screen 3). Exposes the
 * write path the "agents alongside" also use: decide-by urgency (drives the
 * desk's Decide-now / Can-wait split), queue membership, snooze, and
 * route-to-agent. Every write is attributed and rendered as a setting, never a
 * silent mutation. Queue/decide-by/snooze go through the P1 triage APIs; the
 * expiry chip surfaces the underlying decision's TTL read-only.
 */
export function DecisionTriageStrip({ item, companyId, agents }: DecisionTriageStripProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const sourceKind = item.sourceKind;
  const sourceId = item.subject.id;
  const taskRef = attentionTaskRef(item);
  const relatedIssueId = item.relatedIssue?.id
    ?? (typeof item.subject.metadata?.issueId === "string" ? item.subject.metadata.issueId : null)
    ?? (item.subject.kind === "issue" ? item.subject.id : null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.decisionQueues.list(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.decisionQueues.triage(companyId, sourceKind, sourceId) });
  };

  const onError = (verb: string) => (error: unknown) =>
    pushToast({
      title: `Could not ${verb}`,
      body: error instanceof Error ? error.message : "Please try again.",
      tone: "error",
    });

  const setDecideBy = useMutation({
    mutationFn: (decideBy: string | null) =>
      decisionQueuesApi.updateTriage(companyId, sourceKind, sourceId, { decideBy }),
    onSuccess: invalidate,
    onError: onError("set when to decide"),
  });
  const setSnooze = useMutation({
    mutationFn: (snoozedUntil: string | null) =>
      decisionQueuesApi.updateTriage(companyId, sourceKind, sourceId, { snoozedUntil }),
    onSuccess: invalidate,
    onError: onError("snooze"),
  });
  const addToQueue = useMutation({
    mutationFn: (key: string) => decisionQueuesApi.addItem(companyId, key, sourceKind, sourceId),
    onSuccess: invalidate,
    onError: onError("add to queue"),
  });
  const removeFromQueue = useMutation({
    mutationFn: (key: string) => decisionQueuesApi.removeItem(companyId, key, sourceKind, sourceId),
    onSuccess: invalidate,
    onError: onError("remove from queue"),
  });
  const routeToAgent = useMutation({
    mutationFn: (agent: Agent) => {
      if (!relatedIssueId) throw new Error("This decision has no linked task to route from.");
      const mention = `[@${agent.name}](${buildAgentMentionHref(agent.id)})`;
      const body =
        `${mention} — could you look at this decision${taskRef ? ` on ${taskRef.identifier}` : ""}, `
        + `prepare a recommendation, and re-surface it on the decisions desk? (routed from the desk)`;
      return issuesApi.addComment(relatedIssueId, body);
    },
    onSuccess: (_result, agent) => {
      invalidate();
      pushToast({ title: `Routed to ${agent.name}`, tone: "success" });
    },
    onError: onError("route to agent"),
  });

  const pending = setDecideBy.isPending || setSnooze.isPending || addToQueue.isPending || removeFromQueue.isPending;
  const decideBy = item.decideBy;
  const isDatePreset = decideBy != null && /^\d{4}-\d{2}-\d{2}$/.test(decideBy);

  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3"
      data-decision-triage-strip
      // Contained inside the expandable panel; stop the card's expand toggle
      // from firing when the operator interacts with a control.
      onClick={(event) => event.stopPropagation()}
    >
      {/* Expiry — read-only countdown so a dying confirmation is visible. */}
      {item.expiresAt && (() => {
        const { text, overdue } = expiryLabel(item.expiresAt);
        if (!text) return null;
        return (
          <div className="flex items-center gap-1.5 text-xs">
            <AlarmClock className={cn("h-3.5 w-3.5", overdue ? "text-destructive" : "text-muted-foreground")} />
            <span className={overdue ? "font-medium text-destructive" : "text-muted-foreground"}>{text}</span>
          </div>
        );
      })()}

      {/* When to decide — the importance signal that drives desk ordering. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">When to decide</span>
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="When to decide">
          {DECIDE_BY_OPTIONS.map(([value, label]) => (
            <SegmentButton
              key={value}
              active={decideBy === (value satisfies DecideByPreset)}
              disabled={pending}
              onClick={() => setDecideBy.mutate(decideBy === value ? null : value)}
            >
              {label}
            </SegmentButton>
          ))}
          <Popover>
            <PopoverTrigger asChild>
              <SegmentButton active={isDatePreset} disabled={pending}>
                <CalendarClock className="h-3.5 w-3.5" />
                {isDatePreset ? decideByLabel(decideBy) : "Pick date"}
              </SegmentButton>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-auto p-2">
              <input
                type="date"
                defaultValue={isDatePreset ? decideBy ?? "" : ""}
                className="rounded-sm border border-border bg-background px-2 py-1 text-xs"
                onChange={(event) => {
                  if (event.target.value) setDecideBy.mutate(event.target.value);
                }}
              />
            </PopoverContent>
          </Popover>
        </div>
        {/* Provenance ("· set by …") is rendered once, in the card meta row
            (AttentionQueueRow), which shows in both collapsed and expanded
            states — repeating it here duplicated it on the expanded card. */}
      </div>

      {/* Queues — current membership as removable chips + add/create. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Queues</span>
        {item.queues.map((queue) => (
          <span
            key={queue.key}
            className="inline-flex items-center gap-1 rounded-sm border border-border bg-background px-1.5 py-0.5 text-xs"
          >
            {queue.title}
            <button
              type="button"
              className="text-muted-foreground hover:text-destructive disabled:opacity-50"
              aria-label={`Remove from ${queue.title}`}
              disabled={pending}
              onClick={() => removeFromQueue.mutate(queue.key)}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <QueuePicker
          companyId={companyId}
          existingKeys={new Set(item.queues.map((queue) => queue.key))}
          disabled={pending}
          onAdd={(key) => addToQueue.mutate(key)}
        />
      </div>

      {/* Snooze + route-to-agent. */}
      <div className="flex flex-wrap items-center gap-2">
        {item.snoozedUntil ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <AlarmClock className="h-3.5 w-3.5" />
            Snoozed until {new Date(item.snoozedUntil).toLocaleString()}
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              disabled={pending}
              onClick={() => setSnooze.mutate(null)}
            >
              Clear
            </button>
          </span>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="xs" className="h-7 gap-1" disabled={pending}>
                <AlarmClock className="h-3.5 w-3.5" />
                Snooze
                <ChevronDown className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {SNOOZE_PRESETS.map((preset) => (
                <DropdownMenuItem key={preset.label} onClick={() => setSnooze.mutate(preset.resolve())}>
                  {preset.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <RouteToAgentPicker
          agents={agents ?? []}
          disabled={routeToAgent.isPending || !relatedIssueId}
          disabledReason={!relatedIssueId ? "No linked task to route from" : undefined}
          onRoute={(agent) => routeToAgent.mutate(agent)}
        />
        {pending && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>
    </div>
  );
}

function SegmentButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1 rounded-sm border px-2 py-1 text-xs transition-colors disabled:opacity-50",
        active
          ? "border-primary bg-primary/10 font-medium text-primary"
          : "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function QueuePicker({
  companyId,
  existingKeys,
  disabled,
  onAdd,
}: {
  companyId: string;
  existingKeys: Set<string>;
  disabled?: boolean;
  onAdd: (key: string) => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const { data: queues } = useQuery({
    queryKey: queryKeys.decisionQueues.list(companyId),
    queryFn: () => decisionQueuesApi.list(companyId),
    enabled: open,
  });
  const create = useMutation({
    mutationFn: (name: string) =>
      decisionQueuesApi.create(companyId, { key: toQueueKey(name), title: name.trim() }),
    onSuccess: (queue) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.decisionQueues.list(companyId) });
      onAdd(queue.key);
      setTitle("");
      setCreating(false);
      setOpen(false);
    },
    onError: (error) =>
      pushToast({
        title: "Could not create queue",
        body: error instanceof Error ? error.message : "Please try again.",
        tone: "error",
      }),
  });

  const available = (queues ?? []).filter((queue) => !existingKeys.has(queue.key));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="xs" className="h-7 gap-1" disabled={disabled}>
          <Plus className="h-3.5 w-3.5" />
          Queue
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1">
        {creating ? (
          <div className="flex flex-col gap-1.5 p-1">
            <input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && title.trim()) create.mutate(title);
                if (event.key === "Escape") setCreating(false);
              }}
              placeholder="New queue name…"
              className="w-full rounded-sm border border-border bg-background px-2 py-1 text-xs"
            />
            <div className="flex justify-end gap-1">
              <Button type="button" variant="ghost" size="xs" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button type="button" size="xs" disabled={!title.trim() || create.isPending} onClick={() => create.mutate(title)}>
                {create.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
                Create
              </Button>
            </div>
          </div>
        ) : (
          <div className="max-h-64 space-y-0.5 overflow-y-auto">
            {available.length === 0 && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">No other queues yet.</p>
            )}
            {available.map((queue) => (
              <button
                key={queue.key}
                type="button"
                className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                onClick={() => {
                  onAdd(queue.key);
                  setOpen(false);
                }}
              >
                <span className="truncate">{queue.title}</span>
                {queue.itemCount > 0 && (
                  <span className="ml-2 shrink-0 text-(length:--text-nano) tabular-nums text-muted-foreground">
                    {queue.itemCount}
                  </span>
                )}
              </button>
            ))}
            <DropdownMenuSeparatorLike />
            <button
              type="button"
              className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              onClick={() => setCreating(true)}
            >
              <Plus className="h-3.5 w-3.5" />
              New queue…
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function DropdownMenuSeparatorLike() {
  return <div className="my-1 h-px bg-border" />;
}

function RouteToAgentPicker({
  agents,
  disabled,
  disabledReason,
  onRoute,
}: {
  agents: Agent[];
  disabled?: boolean;
  disabledReason?: string;
  onRoute: (agent: Agent) => void;
}) {
  const active = agents.filter((agent) => agent.status !== "terminated");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="h-7 gap-1"
          disabled={disabled || active.length === 0}
          title={disabledReason}
        >
          <UserPlus className="h-3.5 w-3.5" />
          Route to agent
          <ChevronDown className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
        {active.map((agent) => (
          <DropdownMenuItem key={agent.id} onClick={() => onRoute(agent)}>
            {agent.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
