import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface CollectionToolbarProps {
  /** Primary context such as tabs, a view title, or a result count. */
  context?: ReactNode;
  /** The collection's canonical search control. */
  search?: ReactNode;
  /** Filter, sort, column, density, and view controls. */
  controls?: ReactNode;
  /** Collection-specific actions such as create or bulk operations. */
  actions?: ReactNode;
  /** Optional second row for active-filter chips or selection feedback. */
  feedback?: ReactNode;
  className?: string;
  ariaLabel?: string;
}

/**
 * Presentation-only shell for list and board controls.
 *
 * State, queries, and control behavior stay with the consuming surface. Keeping
 * this component slot-based lets Inbox, Tasks, routine runs, and scoped task
 * lists share geometry without coupling their data models.
 */
export function CollectionToolbar({
  context,
  search,
  controls,
  actions,
  feedback,
  className,
  ariaLabel = "Collection controls",
}: CollectionToolbarProps) {
  return (
    <div
      data-slot="collection-toolbar"
      className={cn("flex flex-col gap-2", className)}
      role="toolbar"
      aria-label={ariaLabel}
    >
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
        {context ? (
          <div data-slot="collection-toolbar-context" className="min-w-0 shrink-0">
            {context}
          </div>
        ) : null}
        {search ? (
          <div data-slot="collection-toolbar-search" className="min-w-0 flex-1">
            {search}
          </div>
        ) : null}
        {(controls || actions) ? (
          <div className="flex min-w-0 flex-wrap items-center gap-1 sm:ml-auto sm:flex-nowrap">
            {controls ? (
              <div data-slot="collection-toolbar-controls" className="flex min-w-0 flex-wrap items-center gap-1">
                {controls}
              </div>
            ) : null}
            {actions ? (
              <div data-slot="collection-toolbar-actions" className="flex shrink-0 items-center gap-1">
                {actions}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {feedback ? (
        <div data-slot="collection-toolbar-feedback" className="min-w-0">
          {feedback}
        </div>
      ) : null}
    </div>
  );
}
