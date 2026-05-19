// LET-467 — evidence board for the EAOS Mission detail page.
//
// Renders the normalized list of evidence items produced by `buildEvidenceItems`,
// grouped/filtered by kind. Read-only.

import { useMemo, useState } from "react";
import type { EvidenceItem, EvidenceKind } from "./build-evidence";

const FILTERS: ReadonlyArray<{ id: "all" | EvidenceKind; label: string }> = [
  { id: "all", label: "All" },
  { id: "document", label: "Documents" },
  { id: "work_product", label: "Work products" },
  { id: "validation", label: "Validation" },
  { id: "approval", label: "Approvals" },
  { id: "final_delivery", label: "Final delivery" },
  { id: "interaction", label: "Interactions" },
  { id: "live_run", label: "Live runs" },
  { id: "run", label: "Runs" },
  { id: "comment", label: "Comments" },
  { id: "tree_event", label: "Tree events" },
];

const KIND_EMPTY_COPY: Record<EvidenceKind, string> = {
  document: "No durable mission documents yet.",
  work_product: "No work products have been attached yet.",
  validation: "No validator verdict yet.",
  approval: "No approval requests are linked to this mission.",
  final_delivery: "No final delivery has been queued.",
  interaction: "No interactive requests recorded.",
  run: "No completed runs linked yet.",
  live_run: "No live runs in progress.",
  comment: "No discussion entries yet.",
  tree_event: "No tree timeline events yet.",
};

function formatTimestamp(ts: string | null): string {
  if (!ts) return "—";
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) return "—";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function MissionEvidenceBoard({ items }: { items: ReadonlyArray<EvidenceItem> }) {
  const [filter, setFilter] = useState<"all" | EvidenceKind>("all");

  const visibleItems = useMemo(() => {
    if (filter === "all") return items;
    return items.filter((item) => item.kind === filter);
  }, [items, filter]);

  const totalCount = items.length;

  return (
    <section
      aria-labelledby="eaos-mission-evidence-title"
      className="flex flex-col gap-3 rounded-md border border-border bg-card p-4"
      data-testid="eaos-mission-evidence"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="eaos-mission-evidence-title" className="text-base font-semibold tracking-tight text-foreground">
          Evidence
        </h2>
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
          {totalCount} item{totalCount === 1 ? "" : "s"} · read-only
        </p>
      </header>

      <div
        role="toolbar"
        aria-label="Evidence filters"
        className="flex flex-wrap items-center gap-1.5"
        data-testid="eaos-mission-evidence-toolbar"
      >
        {FILTERS.map((option) => {
          const isActive = filter === option.id;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => setFilter(option.id)}
              aria-pressed={isActive}
              data-testid={`eaos-mission-evidence-filter-${option.id}`}
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

      {totalCount === 0 ? (
        <p
          data-testid="eaos-mission-evidence-empty-all"
          className="rounded-md border border-dashed border-border bg-background p-3 text-xs text-muted-foreground"
        >
          No evidence recorded for this mission yet. Documents, work products, runs, validation,
          approvals, final delivery, comments, and tree events will appear here as they are
          produced.
        </p>
      ) : visibleItems.length === 0 ? (
        <p
          data-testid={`eaos-mission-evidence-empty-${filter}`}
          className="rounded-md border border-dashed border-border bg-background p-3 text-xs text-muted-foreground"
        >
          {filter === "all"
            ? "No evidence recorded for this mission yet."
            : KIND_EMPTY_COPY[filter]}
        </p>
      ) : (
        <ul
          aria-label="Mission evidence items"
          data-testid="eaos-mission-evidence-list"
          className="flex flex-col gap-2"
        >
          {visibleItems.map((item) => (
            <li
              key={item.id}
              data-testid={`eaos-mission-evidence-item-${item.id}`}
              data-evidence-kind={item.kind}
              className="flex flex-col gap-1 rounded-md border border-border bg-background p-3"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium text-foreground" title={item.title}>
                  {item.title}
                </p>
                <time
                  dateTime={item.timestamp ?? undefined}
                  className="text-[11px] text-muted-foreground"
                >
                  {formatTimestamp(item.timestamp)}
                </time>
              </div>
              <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                <span className="rounded-sm bg-muted px-1.5 py-0.5 uppercase tracking-wide">
                  {item.sourceLabel}
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
        </ul>
      )}
    </section>
  );
}
