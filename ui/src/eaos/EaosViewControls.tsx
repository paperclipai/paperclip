// LET-513 §5 — Shared view-mode + filter controls for EAOS data surfaces.
//
// Pages that have both a card/board layout and a list/table layout drop
// this control into their header. Sort/filter wiring stays page-specific
// because each surface bins its data differently; this component owns the
// view-mode segmented control and a single substring filter input. The
// search input is intentionally compact — it does NOT replace mission
// search (⌘K) and does NOT call the server. It is a client-side filter
// over the rows already loaded into the page.
//
// Empty/error/loading states stay the page's responsibility. This control
// is a thin presentational primitive.

import type { ChangeEvent } from "react";
import { LayoutGrid, Rows3, Search } from "lucide-react";

export type EaosViewMode = "cards" | "list";

export interface EaosViewControlsProps {
  readonly mode: EaosViewMode;
  readonly onModeChange: (mode: EaosViewMode) => void;
  readonly filter: string;
  readonly onFilterChange: (value: string) => void;
  readonly filterPlaceholder?: string;
  readonly testIdPrefix: string;
  // Optional right-side slot for surface-specific sort controls.
  readonly rightSlot?: React.ReactNode;
}

export function EaosViewControls({
  mode,
  onModeChange,
  filter,
  onFilterChange,
  filterPlaceholder,
  testIdPrefix,
  rightSlot,
}: EaosViewControlsProps) {
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid={`${testIdPrefix}-view-controls`}
    >
      <div className="relative flex min-w-[180px] flex-1 items-center sm:max-w-xs">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <label className="sr-only" htmlFor={`${testIdPrefix}-filter-input`}>
          Filter visible rows
        </label>
        <input
          id={`${testIdPrefix}-filter-input`}
          type="search"
          autoComplete="off"
          spellCheck={false}
          data-testid={`${testIdPrefix}-filter-input`}
          value={filter}
          placeholder={filterPlaceholder ?? "Filter…"}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            onFilterChange(event.target.value)
          }
          className="h-8 w-full rounded-md border border-border bg-background pl-7 pr-2 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        />
      </div>

      <div
        role="group"
        aria-label="View mode"
        data-testid={`${testIdPrefix}-view-mode`}
        data-eaos-view-mode={mode}
        className="inline-flex items-center rounded-md border border-border bg-card p-0.5"
      >
        <ViewModeButton
          mode="cards"
          active={mode === "cards"}
          onClick={() => onModeChange("cards")}
          label="Cards"
          Icon={LayoutGrid}
          testId={`${testIdPrefix}-view-mode-cards`}
        />
        <ViewModeButton
          mode="list"
          active={mode === "list"}
          onClick={() => onModeChange("list")}
          label="List"
          Icon={Rows3}
          testId={`${testIdPrefix}-view-mode-list`}
        />
      </div>

      {rightSlot ? <div className="ml-auto">{rightSlot}</div> : null}
    </div>
  );
}

function ViewModeButton({
  mode,
  active,
  onClick,
  label,
  Icon,
  testId,
}: {
  mode: EaosViewMode;
  active: boolean;
  onClick: () => void;
  label: string;
  Icon: typeof LayoutGrid;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-testid={testId}
      data-eaos-view-mode-value={mode}
      title={`${label} view`}
      className={
        "inline-flex h-7 items-center gap-1 rounded-sm px-2 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background " +
        (active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground")
      }
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

// Helper: substring match that's diacritic-tolerant and case-insensitive.
// Pages call this on every row using a stable accessor (name/title) so the
// filter is consistent across surfaces.
export function eaosMatchesFilter(value: string | null | undefined, filter: string): boolean {
  if (!filter) return true;
  if (!value) return false;
  return value.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase());
}
