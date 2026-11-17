import { ChevronRight, Clock } from "lucide-react";
import {
  summarizeProviderRateLimits,
  type ProviderRateLimitSnapshot,
  type ProviderRateLimitSummary,
} from "@paperclipai/shared";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";

type Tone = ProviderRateLimitSummary["tone"];

const fillClass: Record<Tone, string> = {
  normal: "bg-muted-foreground/60",
  warn: "bg-(--status-task-todo)",
  reached: "bg-destructive",
};

const textClass: Record<Tone, string> = {
  normal: "text-foreground",
  warn: "text-(--status-task-icon-todo)",
  reached: "text-destructive",
};

export function formatRateLimitClock(iso: string, now: number): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (new Date(now).toDateString() === at.toDateString()) return time;
  if (Math.abs(at.getTime() - now) < 6 * 86_400_000) return `${at.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
  return `${at.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${time}`;
}

function Bar({ pct, tone, className }: { pct: number; tone: Tone; className?: string }) {
  const clamped = Math.min(100, Math.max(0, pct));
  return (
    <span className={cn("relative inline-block h-1.5 overflow-hidden rounded-full bg-muted", className)} aria-hidden>
      <span className={cn("absolute inset-y-0 left-0 rounded-full", fillClass[tone])} style={{ width: `${clamped}%` }} />
    </span>
  );
}

function windowTone(pct: number, reached: boolean): Tone {
  if (reached || pct >= 100) return "reached";
  return pct > 80 ? "warn" : "normal";
}

/** Every current window as a labelled bar; shown inside the property popover. */
export function AgentRateLimitPanel({ snapshot, summary, now }: {
  snapshot: ProviderRateLimitSnapshot;
  summary: ProviderRateLimitSummary;
  now: number;
}) {
  const reachedId = summary.limited ? snapshot.limitReached?.windowId ?? null : null;
  const creditTone = summary.usingCredits ? "warn" : null;
  const credits = snapshot.credits;
  return (
    <div className="space-y-2">
      {summary.current.map((window) => {
        const pct = window.usedPercent ?? 0;
        const tone = window.id === summary.window?.id && creditTone ? creditTone : windowTone(pct, window.id === reachedId);
        return (
          <div key={window.id} className="space-y-1">
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="truncate text-muted-foreground">{window.label}</span>
              <span className={cn("shrink-0 tabular-nums", textClass[tone])}>
                {Math.round(pct)}%
                {window.resetsAt && (
                  <span className="text-muted-foreground"> · resets {formatRateLimitClock(window.resetsAt, now)}</span>
                )}
              </span>
            </div>
            <Bar pct={pct} tone={tone} className="w-full" />
          </div>
        );
      })}
      {summary.usingCredits && (
        <div className="text-xs text-(--status-task-icon-todo)">Limit reached; work continues on account credits.</div>
      )}
      {credits && (credits.unlimited || credits.balance !== null || credits.hasCredits === false) && (
        <div className="text-xs text-muted-foreground">
          {credits.unlimited ? "Unlimited credits" : credits.hasCredits === false ? "No credits remaining" : `${credits.balance} credits`}
        </div>
      )}
    </div>
  );
}

/**
 * One-line "Usage limit" property value: "5h 78% · resets 15:40", amber above
 * 80%, "Limited until 15:40" while the provider refuses work, "using credits"
 * when a used-up window falls back to account credits. Click opens the
 * full window breakdown. Renders nothing when no current limit data exists.
 */
export function AgentRateLimitPropertyValue({ snapshot, now = Date.now(), defaultOpen, detailsHref, className }: {
  snapshot: ProviderRateLimitSnapshot | null;
  now?: number;
  defaultOpen?: boolean;
  /** Link to a fuller usage view, e.g. the agent's page. */
  detailsHref?: string;
  className?: string;
}) {
  const summary = summarizeProviderRateLimits(snapshot, now);
  if (!snapshot || !summary) return null;
  const { window, tone } = summary;
  const label = summary.limited
    ? `Limited${summary.limitedUntil ? ` until ${formatRateLimitClock(summary.limitedUntil, now)}` : ""}`
    : summary.usingCredits
      ? `${window!.shortLabel} ${Math.round(window!.usedPercent ?? 0)}% · using credits`
      : `${window!.shortLabel} ${Math.round(window!.usedPercent ?? 0)}%${window!.resetsAt ? ` · resets ${formatRateLimitClock(window!.resetsAt, now)}` : ""}`;
  return (
    <Popover defaultOpen={defaultOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "group inline-flex min-w-0 items-center gap-1.5 rounded-sm text-xs tabular-nums hover:text-foreground",
            textClass[tone],
            className,
          )}
          aria-label={`Provider usage limit: ${label}`}
        >
          {summary.limited
            ? <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden />
            : <Bar pct={window!.usedPercent ?? 0} tone={tone} className="w-6 shrink-0" />}
          <span className="truncate">{label}</span>
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-3 p-3">
        <div className="text-xs font-medium">{snapshot.provider === "openai" ? "Codex" : "Claude"} usage limits</div>
        <AgentRateLimitPanel snapshot={snapshot} summary={summary} now={now} />
        <div className="flex items-center justify-between gap-3 text-(length:--text-micro) text-muted-foreground">
          <span>Reported {formatRateLimitClock(snapshot.observedAt, now)}</span>
          {detailsHref && <Link to={detailsHref} className="hover:text-foreground hover:underline">View agent</Link>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
