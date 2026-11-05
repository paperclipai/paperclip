import { useId, useState, type ReactNode } from "react";
import { completedActivitySummary } from "./completed-activity-summary";
import {
  Brain,
  ChevronDown,
  ChevronRight,
  BookOpen,
  CirclePause,
  Gauge,
  ShieldX,
} from "lucide-react";
import { useReducedMotion } from "motion/react";
import { MarkdownBody } from "@/components/MarkdownBody";
import { cn } from "@/lib/utils";
import { useTaskChatExpansion } from "./expansion-state";
import type { TaskChatActivityPhaseItem, TaskChatAutoReview } from "./task-chat-model";
import { AutoApprovedBadge, AutoReviewDetail } from "./TaskChatAutoReview";
import {
  protocolActivityIsRunning,
  protocolActivityLabel,
  protocolActivityPresentation,
} from "./task-chat-activity-presentation";
import {
  ResearchSourceStrip,
  TaskChatProtocolActivityDetails,
  WaitCountdown,
  hasTaskChatProtocolActivityDetails,
  verificationOutcome,
  verificationTone,
} from "./TaskChatProtocolActivityRow";
import { TaskChatUsageReadout } from "./TaskChatUsageReadout";
import { TaskChatReasoningSummary } from "./TaskChatReasoningSummary";
import { latestReasoningHeadline } from "./reasoning-summary";
import { toolActivityPresentation, type ToolIcon } from "./tool-taxonomy";
import { useTaskChatShimmer } from "./TaskChatShimmer";
import { TaskChatDiffCounts, TaskChatDiffView } from "./TaskChatDiffView";

type Activity = TaskChatActivityPhaseItem["items"][number];
type ToolActivity = Extract<Activity, { kind: "tool" }>;

/** Families whose rows read as "<verb> <subject>", for example "Ran $ node --test". */
const SUBJECT_FAMILIES = new Set(["terminal", "read", "edit", "grep", "search", "web"]);
const READ_RUN_MIN = 3;

/** "120ms", "1.2s", "14s", "2m 03s". */
export function formatToolDuration(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 10_000) return `${(ms / 1_000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function toolPresentation(item: ToolActivity) {
  // Classify by the native name only: a canonical operation is a weak guess
  // for MCP tools (Claude reports most of them as "execute").
  return toolActivityPresentation({
    name: item.rawName ?? item.name,
    target: item.target,
  });
}

/** Only file reads fold; Skill, LSP and task lookups are also "read" family. */
const FILE_READ_TOOLS = new Set(["read", "notebookread", "notebook_read"]);

function isReadTool(item: Activity): item is ToolActivity {
  return item.kind === "tool"
    && item.status === "completed"
    && !item.blockedReason
    && Boolean(item.target?.trim())
    && FILE_READ_TOOLS.has((item.rawName ?? item.name).trim().toLowerCase());
}

interface ActivityRowPresentation {
  icon: ToolIcon;
  label: string;
  target?: string;
  mono: boolean;
  running: boolean;
  /** Colors the leading icon, e.g. green or red for a verification check. */
  iconClassName?: string;
  /** Short plain-text outcome after the target, e.g. "6 tests passed". */
  trailing?: ReactNode;
  /** A governance row's reason, shown under the row when an action was stopped. */
  note?: string;
  /** Process exit code shown as a chip; null hides it. */
  exitCode?: number | null;
  /** Tool duration shown after the chip; null hides it. */
  durationMs?: number | null;
  /** Why a policy or rule refused the tool. */
  blocked?: string;
}

function providerTrailing(item: Extract<Activity, { kind: "protocol" }>): Pick<ActivityRowPresentation, "iconClassName" | "trailing"> {
  if (item.surface !== "provider_activity") return {};
  if (item.family === "verification") {
    return {
      iconClassName: verificationTone(item),
      trailing: verificationOutcome(item),
    };
  }
  if (item.family === "wait" && item.status === "running") {
    return { trailing: <WaitCountdown item={item} /> };
  }
  return {};
}

function presentation(item: Activity, active: boolean): ActivityRowPresentation | null {
  if (item.kind === "tool") {
    const tool = toolPresentation(item);
    const running =
      active && (item.status === "pending" || item.status === "in_progress");
    const label =
      item.status === "failed"
        ? tool.failedLabel
        : item.status === "interrupted"
          ? tool.interruptedLabel
          : running
            ? tool.runningLabel
            : tool.completedLabel;
    const terminal = tool.family === "terminal";
    const subject = item.target?.trim();
    // With a concrete subject, the verb alone reads better: "Read README.md".
    // A finished command needs no verb at all: the icon and "$" say it ran.
    // A failure or stop keeps its marker ("Read · failed") unless an exit
    // chip already says how a command ended.
    const marker = item.status === "failed" || item.status === "interrupted" ? label.split(" · ").at(1) : undefined;
    const verb = subject && SUBJECT_FAMILIES.has(tool.family)
      ? terminal && !running && (item.status === "completed" || item.exitCode != null)
        ? ""
        : `${label.split(" ")[0]!}${marker ? ` · ${marker}` : ""}`
      : label;
    // Exit 0 is only news for commands; for reads and searches it is noise.
    const exitCode = item.exitCode ?? null;
    const shownExit = exitCode === 0 && !terminal ? null : exitCode;
    if (item.blockedReason) {
      return {
        icon: ShieldX,
        label: "Blocked",
        target: subject ? (terminal ? `$ ${subject}` : subject) : undefined,
        mono: true,
        running: false,
        blocked: item.blockedReason,
      };
    }
    return {
      icon: tool.icon,
      label: verb,
      target: subject ? (terminal ? `$ ${subject}` : subject) : undefined,
      mono: true,
      running,
      exitCode: running ? null : shownExit,
      // Codex reports 0 for calls it did not time; 0ms is never informative.
      durationMs: running || !item.durationMs ? null : item.durationMs,
    };
  }
  if (item.kind === "thinking") {
    const running = active && Boolean(item.streaming);
    return {
      icon: Brain,
      label: running ? "Thinking" : "Thought",
      target:
        latestReasoningHeadline(item.lines.join("\n")) ??
        item.lines
          .filter((line) => line.trim())
          .at(-1)
          ?.trim(),
      mono: false,
      running,
    };
  }
  if (item.kind === "protocol") {
    const protocol = protocolActivityPresentation(item);
    if (!protocol) return null;
    return {
      icon: protocol.icon,
      label: protocolActivityLabel(item, protocol),
      target: protocol.detail,
      mono: true,
      running: active && protocolActivityIsRunning(item),
      ...providerTrailing(item),
      ...(protocol.tone === "blocked" || protocol.tone === "failed" ? { iconClassName: "text-destructive" } : {}),
      note: protocol.note,
    };
  }
  if (item.kind === "marker")
    return {
      icon: CirclePause,
      label: item.label,
      target: item.detail,
      mono: false,
      running: false,
    };
  const { used, size, inputTokens, outputTokens, costUsd } = item.usage;
  const usage = [
    size > 0
      ? `${used.toLocaleString()}/${size.toLocaleString()} ctx`
      : undefined,
    inputTokens != null || outputTokens != null
      ? `↑${(inputTokens ?? 0).toLocaleString()} ↓${(outputTokens ?? 0).toLocaleString()}`
      : undefined,
    costUsd != null ? `$${costUsd.toFixed(4)}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    icon: Gauge,
    label: item.label ?? "Token usage",
    target: usage || item.detail,
    mono: false,
    running: false,
  };
}

function ActivityContent({
  item,
  active,
}: {
  item: Activity;
  active: boolean;
}) {
  const row = presentation(item, active);
  const shimmer = useTaskChatShimmer(item.id);
  if (!row) return null;
  const Icon = row.icon;
  const autoReview = itemAutoReview(item);
  const exitCode = "exitCode" in row ? row.exitCode : null;
  const durationMs = "durationMs" in row ? row.durationMs : null;
  const blocked = "blocked" in row ? row.blocked : undefined;
  return (
    <span
      className="flex min-w-0 flex-1 items-center gap-2"
      data-activity-row={item.id}
      data-activity-family={
        item.kind === "protocol"
          ? item.surface === "provider_activity"
            ? item.family
            : item.surface
          : undefined
      }
    >
      <span
        className="flex size-5 shrink-0 items-center justify-center"
        data-activity-icon
      >
        <Icon className={cn("size-3.5", row.iconClassName, blocked && "text-destructive")} aria-hidden="true" />
      </span>
      <span data-conversation-tool-running={row.running && shimmer && (item.kind === "tool" || (item.kind === "protocol" && item.surface === "provider_activity" && item.family === "tool_execution")) ? "true" : undefined} className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden whitespace-nowrap">
        {row.label ? <span
          className={cn(
            "max-w-full shrink-0 truncate text-xs",
            row.running && "text-foreground",
            row.running && shimmer && item.kind === "thinking" && "shimmer-text",
          )}
        >
          {row.label}
        </span> : null}
        {row.target ? (
          <span
            title={row.target}
            className={cn(
              "truncate text-xs text-muted-foreground",
              row.mono && "font-mono",
            )}
          >
            {row.target}
          </span>
        ) : null}
        {blocked ? (
          <span title={blocked} className="min-w-0 truncate text-xs text-destructive" data-tool-blocked-reason>
            {blocked}
          </span>
        ) : null}
        {row.trailing ? (
          <span className="min-w-0 truncate text-xs text-muted-foreground" data-testid="task-chat-activity-trailing">
            {row.trailing}
          </span>
        ) : null}
      </span>
      {exitCode != null || durationMs != null ? (
        <span className="flex shrink-0 items-center gap-2 text-(length:--text-micro) tabular-nums" data-tool-outcome>
          {exitCode != null ? (
            <span
              className={cn(
                "rounded-sm px-1 font-mono leading-4",
                exitCode === 0 ? "bg-muted text-muted-foreground" : "bg-destructive/10 text-destructive",
              )}
              data-tool-exit-code={exitCode}
            >
              exit {exitCode}
            </span>
          ) : null}
          {durationMs != null ? (
            <span className="text-muted-foreground" data-tool-duration>{formatToolDuration(durationMs)}</span>
          ) : null}
        </span>
      ) : null}
      {item.kind === "tool" && item.diff && (item.diff.added > 0 || item.diff.removed > 0) ? (
        <TaskChatDiffCounts
          added={item.diff.added}
          removed={item.diff.removed}
          className="text-xs"
        />
      ) : null}
      {autoReview ? <AutoApprovedBadge review={autoReview} /> : null}
    </span>
  );
}

/** Only a new logical activity moves; token and status updates stay mounted. */
function RollingActivity({
  item,
  active,
}: {
  item: Activity;
  active: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const [frame, setFrame] = useState({
    current: item,
    previous: null as Activity | null,
  });
  if (frame.current.id !== item.id)
    setFrame({ current: item, previous: reducedMotion ? null : frame.current });
  else if (frame.current !== item) setFrame({ ...frame, current: item });
  return (
    <span
      className="relative flex h-8 min-w-0 flex-1 items-center overflow-hidden"
      aria-live="polite"
      aria-atomic="true"
      data-testid="task-chat-activity-viewport"
    >
      {frame.previous && !reducedMotion ? (
        <span
          key={`exit-${item.id}`}
          className="runner-activity-roll-out absolute inset-0 flex items-center"
          aria-hidden="true"
          onAnimationEnd={() =>
            setFrame((current) =>
              current.current.id === item.id
                ? { ...current, previous: null }
                : current,
            )
          }
        >
          <ActivityContent item={frame.previous} active={false} />
        </span>
      ) : null}
      <span
        key={item.id}
        className={cn(
          "relative flex w-full min-w-0 items-center",
          frame.previous && !reducedMotion && "runner-activity-roll-in",
        )}
      >
        <ActivityContent item={item} active={active} />
      </span>
    </span>
  );
}

function itemAutoReview(item: Activity): TaskChatAutoReview | undefined {
  if (item.kind === "tool") return item.autoReview;
  if (item.kind === "protocol" && item.surface === "provider_activity") return item.autoReview;
  return undefined;
}

function ActivityDetails({ item }: { item: Activity }) {
  // Protocol rows render their review inside TaskChatProtocolActivityDetails.
  const autoReview = item.kind === "tool" ? item.autoReview : undefined;
  return (
    <>
      <ActivityDetailsBody item={item} />
      {autoReview ? <AutoReviewDetail review={autoReview} /> : null}
    </>
  );
}

function ActivityDetailsBody({ item }: { item: Activity }) {
  if (item.kind === "thinking")
    return <TaskChatReasoningSummary text={item.lines.join("\n")} streaming={Boolean(item.streaming)} />;
  if (item.kind === "usage") return <TaskChatUsageReadout item={item} />;
  if (item.kind === "protocol")
    return <TaskChatProtocolActivityDetails item={item} neutral />;
  if (item.kind === "marker")
    return (
      <p className="whitespace-pre-wrap break-words">
        {item.detail ?? item.label}
      </p>
    );
  if (item.diff?.lines?.length)
    return (
      <TaskChatDiffView lines={item.diff.lines} truncated={item.diff.truncated} />
    );
  return (
    <>
      {item.description ? <p>{item.description}</p> : null}
      {item.target ? (
        <p className="break-all font-mono">{item.target}</p>
      ) : null}
      {item.blockedReason ? <p className="text-destructive">Blocked: {item.blockedReason}</p> : null}
      {item.detail ? (
        <pre className="whitespace-pre-wrap break-words font-mono">
          {item.detail}
        </pre>
      ) : null}
      {item.decision ? <p>Permission {item.decision}</p> : null}
      {item.diff ? (
        <p className="break-all font-mono">
          {item.diff.path} · +{item.diff.added} −{item.diff.removed}
        </p>
      ) : null}
    </>
  );
}

function hasActivityDetails(item: Activity): boolean {
  if (itemAutoReview(item)) return true;
  if (item.kind === "protocol") return hasTaskChatProtocolActivityDetails(item);
  if (item.kind === "thinking") return item.lines.some((line) => line.trim());
  if (item.kind === "tool")
    return Boolean(
      item.target?.trim() || item.detail?.trim() || item.diff || item.decision || item.blockedReason || item.description,
    );
  if (item.kind === "marker") return Boolean(item.detail?.trim());
  return Boolean(
    item.detail ||
    item.usage.size > 0 ||
    item.usage.inputTokens != null ||
    item.usage.outputTokens != null ||
    item.usage.costUsd != null,
  );
}

function ExpandedActivity({
  item,
  active,
}: {
  item: Activity;
  active: boolean;
}) {
  const [open, setOpen] = useTaskChatExpansion(
    `runner-detail:${item.id}`,
    false,
  );
  const detailId = useId();
  const expandable = hasActivityDetails(item);
  const content = <ActivityContent item={item} active={active} />;
  const row = presentation(item, active);
  const note = row?.note;
  return (
    <li className="min-w-0" data-activity-item-id={item.id}>
      {expandable ? (
        <button
          type="button"
          className="flex h-8 w-full min-w-0 items-center gap-2 rounded-sm text-left text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-controls={open ? detailId : undefined}
        >
          {content}
          <ChevronRight
            className={cn("size-3.5 shrink-0", open && "rotate-90")}
            aria-hidden="true"
          />
        </button>
      ) : (
        <div className="flex h-8 w-full min-w-0 items-center gap-2 text-muted-foreground">
          {content}
        </div>
      )}
      {note ? (
        <p
          className="-mt-1 mb-1 min-w-0 whitespace-pre-wrap break-words pl-7 text-xs text-muted-foreground"
          data-testid="task-chat-governance-note"
        >
          {note}
        </p>
      ) : null}
      {!open && item.kind === "protocol" && item.surface === "provider_activity" && item.family === "research" && item.status !== "running" ? (
        <ResearchSourceStrip item={item} />
      ) : null}
      {expandable && open ? (
        <div
          id={detailId}
          className="flex min-w-0 flex-col gap-2 overflow-hidden rounded-md bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground"
          data-testid="task-chat-runner-activity-detail"
        >
          <ActivityDetails item={item} />
        </div>
      ) : null}
    </li>
  );
}

type HistoryRow = { kind: "single"; item: Activity; index: number } | { kind: "reads"; items: ToolActivity[]; index: number };

/** Fold runs of completed file reads into one row; everything else stays one row per activity. */
export function foldReadRuns(activities: Activity[]): HistoryRow[] {
  const rows: HistoryRow[] = [];
  for (let index = 0; index < activities.length; ) {
    let end = index;
    while (end < activities.length && isReadTool(activities[end]!)) end += 1;
    if (end - index >= READ_RUN_MIN) {
      rows.push({ kind: "reads", items: activities.slice(index, end) as ToolActivity[], index: end - 1 });
      index = end;
    } else {
      rows.push({ kind: "single", item: activities[index]!, index });
      index += 1;
    }
  }
  return rows;
}

function readRunPreview(items: ToolActivity[]): string {
  const names = items.flatMap((item) => item.target?.trim() ? [item.target.trim().split("/").at(-1)!] : []);
  return names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", ");
}

function ReadRunActivity({ items }: { items: ToolActivity[] }) {
  const id = `runner-reads:${items[0]!.id}`;
  const [open, setOpen] = useTaskChatExpansion(id, false);
  const listId = useId();
  return (
    <li className="min-w-0" data-activity-read-run={items.length}>
      <button
        type="button"
        className="flex h-8 w-full min-w-0 items-center gap-2 rounded-sm text-left text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="flex size-5 shrink-0 items-center justify-center">
            <BookOpen className="size-3.5" aria-hidden="true" />
          </span>
          <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden whitespace-nowrap">
            <span className="shrink-0 text-xs">Read {items.length} files</span>
            <span className="truncate font-mono text-xs text-muted-foreground">{readRunPreview(items)}</span>
          </span>
        </span>
        <ChevronRight className={cn("size-3.5 shrink-0", open && "rotate-90")} aria-hidden="true" />
      </button>
      {open ? (
        <ol id={listId} className="ml-2.5 flex min-w-0 flex-col border-l border-border pl-2" aria-label="Files read">
          {items.map((item) => (
            <ExpandedActivity key={item.id} item={item} active={false} />
          ))}
        </ol>
      ) : null}
    </li>
  );
}

/** One rolling activity between commentary messages, with persistent optional history. */
export function TaskChatRunnerActivityGroup({
  item,
  defaultExpanded = false,
}: {
  item: TaskChatActivityPhaseItem;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useTaskChatExpansion(
    item.id,
    defaultExpanded,
  );
  const historyId = useId();
  const activities = item.items.filter(
    (activity) => presentation(activity, false) !== null,
  );
  const latest = activities.at(-1);
  const summary = completedActivitySummary(activities);
  const SummaryIcon = summary.icon;
  const countLabel = `${activities.length} ${activities.length === 1 ? "activity" : "activities"}`;
  const editTotals = activities.reduce(
    (sum, activity) =>
      activity.kind === "tool" && activity.diff
        ? { added: sum.added + activity.diff.added, removed: sum.removed + activity.diff.removed }
        : sum,
    { added: 0, removed: 0 },
  );
  return (
    <section
      className="flex min-w-0 flex-col gap-2"
      data-testid="task-chat-activity-phase"
      data-activity-group={item.id}
      data-expanded={expanded}
    >
      {item.interstitial ? (
        <div
          className="min-w-0 px-1 text-sm text-foreground/90"
          data-testid="task-chat-phase-interstitial"
          data-conversation-text={item.interstitial.channel === "final" ? "final" : "progress"}
        >
          <MarkdownBody softBreaks linkIssueReferences>
            {item.interstitial.text}
          </MarkdownBody>
        </div>
      ) : null}
      {latest ? (
        <div className="min-w-0">
          <button
            type="button"
            className="flex min-h-8 w-full min-w-0 items-center gap-2 rounded-sm text-left text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="task-chat-activity-phase-toggle"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
            aria-controls={expanded ? historyId : undefined}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${item.active ? countLabel : `${summary.fullLabel.toLowerCase()} (${countLabel})`}`}
          >
            {!item.active ? (
              <span
                className="flex h-8 min-w-0 flex-1 items-center gap-2 text-xs"
                data-completed-summary
              >
                <span className="flex size-5 shrink-0 items-center justify-center">
                  <SummaryIcon className="size-3.5" aria-hidden="true" />
                </span>
                <span className="truncate" title={summary.fullLabel}>
                  {summary.label}
                </span>
              </span>
            ) : expanded ? (
              <span className="flex min-h-8 flex-1 items-center gap-2 text-xs">
                <span className="flex size-5 shrink-0 items-center justify-center">
                  <ChevronDown className="size-3.5" aria-hidden="true" />
                </span>
                <span>{countLabel}</span>
              </span>
            ) : (
              <RollingActivity item={latest} active={item.active} />
            )}
            <span className="flex shrink-0 items-center gap-1 text-xs">
              {!item.active && (editTotals.added > 0 || editTotals.removed > 0) ? (
                <TaskChatDiffCounts
                  added={editTotals.added}
                  removed={editTotals.removed}
                  className="mr-1"
                />
              ) : null}
              {expanded ? countLabel : item.active ? activities.length : null}
              <ChevronRight
                className={cn("size-3.5", expanded && "rotate-90")}
                aria-hidden="true"
              />
            </span>
          </button>
          {expanded ? (
            <ol
              id={historyId}
              className="flex min-w-0 flex-col gap-1"
              aria-label="Activity history"
              data-testid="task-chat-runner-activity-list"
            >
              {foldReadRuns(activities).map((row) =>
                row.kind === "reads" ? (
                  <ReadRunActivity key={row.items[0]!.id} items={row.items} />
                ) : (
                  <ExpandedActivity
                    key={row.item.id}
                    item={row.item}
                    active={item.active && row.index === activities.length - 1}
                  />
                ),
              )}
            </ol>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
