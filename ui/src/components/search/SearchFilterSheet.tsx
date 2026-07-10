import { useEffect, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { COMPANY_SEARCH_SORTS, type CompanySearchSort } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import {
  applyAssigneeToken,
  assigneeToken,
  countActiveFilters,
  SORT_LABELS,
  type SearchFilters,
} from "@/lib/search-filters";
import { buildSearchFilterOptions, type SearchFilterDataProps } from "./SearchFilterBar";
import type { FilterMenuOption } from "./SearchFilterMenu";

function ChipToggleGroup({
  title,
  options,
  selected,
  onToggle,
}: {
  title: string;
  options: FilterMenuOption[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  if (options.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground">{title}</div>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => {
          const isActive = selected.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
                isActive
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
              )}
              onClick={() => onToggle(option.value)}
            >
              {option.swatch ? (
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: option.swatch }} aria-hidden />
              ) : null}
              <span>{option.label}</span>
              {typeof option.count === "number" ? (
                <span className={cn("tabular-nums", isActive ? "opacity-80" : "text-muted-foreground/70")}>
                  {option.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function SearchFilterSheet({
  open,
  onOpenChange,
  filters,
  onApply,
  onDraftChange,
  previewTotal,
  data,
  sort,
  onSortChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filters: SearchFilters;
  onApply: (next: SearchFilters) => void;
  /** Fires whenever the in-sheet draft changes so the parent can preview the count. */
  onDraftChange: (draft: SearchFilters) => void;
  /** Total result count for the current draft, previewed before applying. */
  previewTotal: number | null;
  data: SearchFilterDataProps;
  sort: CompanySearchSort;
  onSortChange: (next: CompanySearchSort) => void;
}) {
  const [draft, setDraft] = useState<SearchFilters>(filters);
  const options = buildSearchFilterOptions(data);

  // Re-seed the draft from committed filters each time the sheet opens.
  useEffect(() => {
    if (open) {
      setDraft(filters);
      onDraftChange(filters);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function update(next: SearchFilters) {
    setDraft(next);
    onDraftChange(next);
  }

  function toggleMulti(dimension: "status" | "priority", value: string) {
    const current = (draft[dimension] ?? []) as string[];
    const next = current.includes(value)
      ? current.filter((entry) => entry !== value)
      : [...current, value];
    update({ ...draft, [dimension]: next });
  }

  function toggleAssignee(token: string) {
    const current = assigneeToken(draft, data.currentUserId);
    update(applyAssigneeToken(draft, current === token ? undefined : token, data.currentUserId));
  }

  function toggleSingle(dimension: "projectId" | "labelId" | "updatedWithin", value: string) {
    const current = draft[dimension];
    update({ ...draft, [dimension]: current === value ? undefined : value });
  }

  const activeCount = countActiveFilters(draft);
  const selectedAssignee = assigneeToken(draft, data.currentUserId);
  const applyLabel =
    previewTotal === null
      ? "Show results"
      : `Show ${previewTotal} ${previewTotal === 1 ? "result" : "results"}`;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-(--sz-85vh) gap-0 rounded-t-xl p-0" data-testid="search-filter-sheet">
        <SheetHeader className="flex-row items-center justify-between border-b border-border">
          <SheetTitle className="text-base">Filters</SheetTitle>
          <button
            type="button"
            className={cn("text-xs text-muted-foreground hover:text-foreground", activeCount === 0 && "invisible")}
            onClick={() => update({})}
          >
            Clear all
          </button>
        </SheetHeader>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          <ChipToggleGroup
            title="Status"
            options={options.status}
            selected={draft.status ?? []}
            onToggle={(value) => toggleMulti("status", value)}
          />
          <ChipToggleGroup
            title="Priority"
            options={options.priority}
            selected={draft.priority ?? []}
            onToggle={(value) => toggleMulti("priority", value)}
          />
          <ChipToggleGroup
            title="Assignee"
            options={options.assignee}
            selected={selectedAssignee ? [selectedAssignee] : []}
            onToggle={toggleAssignee}
          />
          <ChipToggleGroup
            title="Project"
            options={options.project}
            selected={draft.projectId ? [draft.projectId] : []}
            onToggle={(value) => toggleSingle("projectId", value)}
          />
          <ChipToggleGroup
            title="Label"
            options={options.label}
            selected={draft.labelId ? [draft.labelId] : []}
            onToggle={(value) => toggleSingle("labelId", value)}
          />
          <ChipToggleGroup
            title="Updated"
            options={options.updated}
            selected={draft.updatedWithin ? [draft.updatedWithin] : []}
            onToggle={(value) => toggleSingle("updatedWithin", value)}
          />
          <div className="space-y-1.5">
            <div className="text-xs font-medium text-muted-foreground">Sort by</div>
            <div className="flex flex-wrap gap-1.5">
              {COMPANY_SEARCH_SORTS.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs transition-colors",
                    value === sort
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                  )}
                  onClick={() => onSortChange(value)}
                >
                  {SORT_LABELS[value]}
                </button>
              ))}
            </div>
          </div>
        </div>

        <SheetFooter className="flex-row gap-2 border-t border-border">
          <SheetClose asChild>
            <Button variant="outline" className="flex-1">
              Cancel
            </Button>
          </SheetClose>
          <Button
            className="flex-1"
            onClick={() => {
              onApply(draft);
              onOpenChange(false);
            }}
          >
            {applyLabel}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/** The compact "Filters · n" trigger button shown on mobile. */
export function SearchFilterSheetTrigger({
  activeCount,
  onClick,
}: {
  activeCount: number;
  onClick: () => void;
}) {
  return (
    <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs font-normal" onClick={onClick}>
      <SlidersHorizontal className="h-3.5 w-3.5" />
      Filters
      {activeCount > 0 ? (
        <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-(length:--text-nano) font-semibold tabular-nums text-primary-foreground">
          {activeCount}
        </span>
      ) : null}
    </Button>
  );
}
