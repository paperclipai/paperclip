import { useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/timeAgo";
import { formatContextTokens } from "@/lib/context-tokens";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export { formatContextTokens };

/**
 * Latest context-window snapshot for the agent's live session. Built from
 * provider usage events (Codex `thread/tokenUsage/updated`, ACP `usage_update`).
 */
export interface ContextUsage {
  /** Tokens currently occupying the context window. */
  usedTokens: number;
  /** Model context window size in tokens. */
  contextWindow: number;
  /** Token count at which the harness compacts on its own, when known. */
  autoCompactTokens?: number | null;
  /** Session totals, when the provider reports them. */
  totals?: {
    inputTokens?: number | null;
    cachedInputTokens?: number | null;
    outputTokens?: number | null;
    reasoningOutputTokens?: number | null;
  } | null;
  /** Most recent model request, when the provider reports it. */
  lastTurn?: { inputTokens?: number | null; outputTokens?: number | null } | null;
  costUsd?: number | null;
  /** Number of compactions so far in this session. */
  compactions?: number;
  /** When the provider reported this reading (ISO timestamp). */
  observedAt?: string | null;
}

export type ContextUsageLevel = "normal" | "near" | "full";

/** Amber once the context is within reach of auto-compaction, red when nearly full. */
export function contextUsageLevel(usage: ContextUsage): ContextUsageLevel {
  const fraction = usage.usedTokens / usage.contextWindow;
  if (fraction >= 0.95) return "full";
  const threshold = usage.autoCompactTokens && usage.autoCompactTokens > 0
    ? usage.autoCompactTokens / usage.contextWindow
    : 0.9;
  return fraction >= threshold - 0.1 ? "near" : "normal";
}

const LEVEL_TEXT: Record<ContextUsageLevel, string> = {
  normal: "text-foreground",
  near: "text-(--status-agent-paused)",
  full: "text-(--status-agent-error)",
};

const LEVEL_FILL: Record<ContextUsageLevel, string> = {
  normal: "bg-muted-foreground",
  near: "bg-(--status-agent-paused)",
  full: "bg-(--status-agent-error)",
};

function Bar({ percent, level, className }: { percent: number; level: ContextUsageLevel; className?: string }) {
  return (
    <div className={cn("h-1 overflow-hidden rounded-full bg-border", className)}>
      <div
        className={cn("h-full rounded-full transition-all duration-500", LEVEL_FILL[level])}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("font-mono tabular-nums", muted ? "text-muted-foreground" : "text-foreground")}>{value}</dd>
    </div>
  );
}

function ContextUsageCard({ usage }: { usage: ContextUsage }) {
  const percent = Math.min(100, Math.round((usage.usedTokens / usage.contextWindow) * 100));
  const level = contextUsageLevel(usage);
  const totals = usage.totals;
  return (
    <div className="flex flex-col">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium text-foreground">Context window</span>
        <span className={cn("font-medium tabular-nums", LEVEL_TEXT[level])}>{percent}%</span>
      </div>
      <p className="mt-0.5 text-muted-foreground tabular-nums">
        {formatContextTokens(usage.usedTokens)} of {formatContextTokens(usage.contextWindow)} tokens
        {usage.observedAt ? <> · updated {timeAgo(usage.observedAt)}</> : null}
      </p>
      <Bar percent={percent} level={level} className="mt-2 w-full" />
      {level !== "normal" ? (
        <p className={cn("mt-2", LEVEL_TEXT[level])}>
          {usage.autoCompactTokens
            ? `Compacts automatically near ${formatContextTokens(usage.autoCompactTokens)}.`
            : "Close to full. The agent will compact its context soon."}
        </p>
      ) : null}
      {totals || usage.lastTurn || usage.costUsd != null || usage.compactions ? (
        <dl className="mt-3 flex flex-col gap-1 border-t border-border pt-2">
          {totals?.inputTokens != null ? (
            <Row
              label="Input"
              value={totals.cachedInputTokens
                ? `${formatContextTokens(totals.inputTokens)} · ${formatContextTokens(totals.cachedInputTokens)} cached`
                : formatContextTokens(totals.inputTokens)}
            />
          ) : null}
          {totals?.outputTokens != null ? <Row label="Output" value={formatContextTokens(totals.outputTokens)} /> : null}
          {totals?.reasoningOutputTokens ? (
            <Row label="Reasoning" value={formatContextTokens(totals.reasoningOutputTokens)} muted />
          ) : null}
          {usage.lastTurn ? (
            <Row
              label="Last request"
              value={`${formatContextTokens(usage.lastTurn.inputTokens ?? 0)} in · ${formatContextTokens(usage.lastTurn.outputTokens ?? 0)} out`}
              muted
            />
          ) : null}
          {usage.costUsd != null ? <Row label="Cost" value={`$${usage.costUsd.toFixed(2)}`} /> : null}
          {usage.compactions ? <Row label="Compactions" value={String(usage.compactions)} muted /> : null}
        </dl>
      ) : null}
    </div>
  );
}

/**
 * Context row value for the task Properties panel: a thin fill bar and
 * "64% of 272k". Hover or tap opens the token breakdown.
 */
export function ContextUsageMeter({
  usage,
  defaultOpen = false,
}: {
  usage: ContextUsage;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const percent = Math.min(100, Math.round((usage.usedTokens / usage.contextWindow) * 100));
  const level = contextUsageLevel(usage);
  const windowLabel = formatContextTokens(usage.contextWindow);
  const show = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(true);
  };
  // A short grace period lets the pointer travel from the row into the card.
  const hide = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 150);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Context window: ${percent}% of ${windowLabel} tokens used`}
          data-testid="context-usage-meter"
          data-level={level}
          onMouseEnter={show}
          onMouseLeave={hide}
          className="-mx-1 flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-sm transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Bar percent={percent} level={level} className="w-12 shrink-0" />
          <span className={cn("truncate tabular-nums", level === "normal" ? "text-foreground" : LEVEL_TEXT[level])}>
            {percent}%
            <span className="text-muted-foreground"> of {windowLabel}</span>
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="left"
        align="start"
        className="w-64 p-3 text-xs"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onMouseEnter={show}
        onMouseLeave={hide}
      >
        <ContextUsageCard usage={usage} />
      </PopoverContent>
    </Popover>
  );
}
