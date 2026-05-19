// LET-467 — replay feed for the EAOS Mission detail page.

import { useMemo, useState } from "react";
import type { ReplayItem, ReplaySeverity } from "./build-replay";

type ReplayFilter = "all" | "live" | "runs" | "decisions" | "docs" | "comments" | "errors";

const FILTERS: ReadonlyArray<{ id: ReplayFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "live", label: "Live" },
  { id: "runs", label: "Runs" },
  { id: "decisions", label: "Decisions" },
  { id: "docs", label: "Docs" },
  { id: "comments", label: "Comments" },
  { id: "errors", label: "Errors" },
];

function severityTone(severity: ReplaySeverity): string {
  switch (severity) {
    case "live":
      return "border-l-2 border-l-red-500";
    case "error":
      return "border-l-2 border-l-red-300";
    case "warning":
      return "border-l-2 border-l-amber-400";
    case "success":
      return "border-l-2 border-l-emerald-400";
    default:
      return "border-l-2 border-l-border";
  }
}

function severityLabel(severity: ReplaySeverity): string {
  return severity.toUpperCase();
}

function passesFilter(item: ReplayItem, filter: ReplayFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "live":
      return item.severity === "live";
    case "runs":
      return item.kind === "run" || item.kind === "live_run";
    case "decisions":
      return (
        item.kind === "validation"
        || item.kind === "approval"
        || item.kind === "interaction"
        || item.kind === "final_delivery"
      );
    case "docs":
      return item.kind === "document" || item.kind === "work_product";
    case "comments":
      return item.kind === "comment";
    case "errors":
      return item.severity === "error";
    default:
      return true;
  }
}

function formatTimestamp(ts: string): string {
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) return "—";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export function MissionReplayFeed({ items }: { items: ReadonlyArray<ReplayItem> }) {
  const [filter, setFilter] = useState<ReplayFilter>("all");

  const visibleItems = useMemo(() => items.filter((item) => passesFilter(item, filter)), [items, filter]);

  return (
    <section
      aria-labelledby="eaos-mission-replay-title"
      className="flex flex-col gap-3 rounded-md border border-border bg-card p-4"
      data-testid="eaos-mission-replay"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="eaos-mission-replay-title" className="text-base font-semibold tracking-tight text-foreground">
          Replay
        </h2>
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
          {items.length} event{items.length === 1 ? "" : "s"} · newest first
        </p>
      </header>

      <div
        role="toolbar"
        aria-label="Replay filters"
        data-testid="eaos-mission-replay-toolbar"
        className="flex flex-wrap items-center gap-1.5"
      >
        {FILTERS.map((option) => {
          const isActive = filter === option.id;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => setFilter(option.id)}
              aria-pressed={isActive}
              data-testid={`eaos-mission-replay-filter-${option.id}`}
              className={
                "inline-flex items-center rounded-md border px-2 py-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background "
                + (isActive
                  ? "border-foreground bg-foreground text-background"
                  : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground")
              }
            >
              {option.label}
            </button>
          );
        })}
      </div>

      {items.length === 0 ? (
        <p
          data-testid="eaos-mission-replay-empty-all"
          className="rounded-md border border-dashed border-border bg-background p-3 text-xs text-muted-foreground"
        >
          No replay events recorded for this mission yet. Run, comment, validation, approval,
          document, and tree events will appear here as they are produced.
        </p>
      ) : visibleItems.length === 0 ? (
        <p
          data-testid={`eaos-mission-replay-empty-${filter}`}
          className="rounded-md border border-dashed border-border bg-background p-3 text-xs text-muted-foreground"
        >
          No events match this filter.
        </p>
      ) : (
        <ol
          aria-label="Mission replay timeline"
          data-testid="eaos-mission-replay-list"
          className="flex flex-col gap-2"
        >
          {visibleItems.map((item) => (
            <li
              key={item.id}
              data-testid={`eaos-mission-replay-item-${item.id}`}
              data-replay-kind={item.kind}
              data-replay-severity={item.severity}
              className={`flex flex-col gap-1 rounded-md bg-background p-3 ${severityTone(item.severity)}`}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium text-foreground">{item.title}</p>
                <time
                  dateTime={item.timestamp}
                  className="text-[11px] text-muted-foreground"
                >
                  {formatTimestamp(item.timestamp)}
                </time>
              </div>
              <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                <span className="rounded-sm bg-muted px-1.5 py-0.5 uppercase tracking-wide">
                  {severityLabel(item.severity)}
                </span>
                {item.state ? <span className="rounded-sm border border-border px-1.5 py-0.5">{item.state}</span> : null}
                {item.actor ? <span>{item.actor}</span> : null}
              </div>
              {item.summary ? (
                <p className="text-xs text-foreground whitespace-pre-line break-words">
                  {item.summary}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
