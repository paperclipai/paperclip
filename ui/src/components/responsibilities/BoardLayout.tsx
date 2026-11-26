import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The Dashboard's board layout for the Board (status columns): one sticky row
 * of four column headers, each area as a one-line section header with one
 * cell per column beneath, and on narrow boards each non-empty column as a
 * labelled group of wrapping cards. The view owns the columns, the labels and
 * the cards. The Automation view reuses the area header (`BoardAreaHeader`).
 */

/** The grid with its sticky column headers (wide boards only; narrow boards label each group). */
export function BoardGrid({ headers, children }: { headers: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4" data-board-grid="">
      <div
        aria-hidden="true"
        className="sticky top-0 z-10 hidden bg-background py-2 @4xl:grid @4xl:grid-cols-4 @4xl:gap-3"
        data-board-columns=""
      >
        {headers}
      </div>
      {children}
    </div>
  );
}

/** An area as a section header: its name, then a quiet line (how many, and a share in bold). */
export function BoardAreaHeader({
  headingId,
  title,
  archived,
  ownedLabel,
  shareLabel,
}: {
  headingId: string;
  title: string;
  archived: boolean;
  ownedLabel: string;
  shareLabel: string | null;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
      <h2 id={headingId} className="min-w-0 text-sm font-semibold text-foreground">
        {title}
        {archived ? <span className="font-normal text-muted-foreground"> · Archived</span> : null}
      </h2>
      <p className="text-xs text-muted-foreground">
        {ownedLabel}
        {shareLabel ? (
          <>
            <span aria-hidden="true"> · </span>
            <span className="font-medium tabular-nums text-foreground">{shareLabel}</span>
          </>
        ) : null}
      </p>
    </div>
  );
}

/**
 * One area: its header, then on a wide board one cell per column with its
 * cards stacked (an empty cell stays a quiet gap), aligned to the column
 * headers. On a narrow board each column the area has becomes a labelled
 * group of wrapping cards.
 */
export function BoardAreaSection<K extends string, T>({
  headingId,
  areaKey,
  header,
  columns,
  cells,
  renderLabel,
  renderCard,
}: {
  headingId: string;
  areaKey: string;
  header: ReactNode;
  columns: readonly K[];
  cells: Record<K, readonly T[]>;
  /** The column's label for narrow boards; `className` hides it on wide ones. */
  renderLabel: (column: K, count: number, className: string) => ReactNode;
  renderCard: (item: T) => ReactNode;
}) {
  return (
    <section aria-labelledby={headingId} data-board-area={areaKey} className="flex flex-col gap-3 border-t border-border pt-4">
      {header}
      <div className="flex flex-col gap-3 @4xl:grid @4xl:grid-cols-4 @4xl:gap-3">
        {columns.map((column) => {
          const items = cells[column];
          return (
            <div
              key={column}
              data-board-cell={column}
              className={cn("flex min-w-0 flex-col gap-2", items.length === 0 && "hidden @4xl:flex")}
            >
              {items.length > 0 ? (
                <>
                  {renderLabel(column, items.length, "@4xl:sr-only")}
                  <ul className="grid grid-cols-(--responsibility-board-wrap-cols) gap-2 @4xl:grid-cols-1">
                    {items.map(renderCard)}
                  </ul>
                </>
              ) : (
                <div aria-hidden="true" className="h-12 rounded-lg border border-dashed border-border/60" />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
