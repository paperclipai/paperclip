import { type ReactNode } from "react";
import { ArrowUpDown, Check, GraduationCap, Layers, ListFilter } from "lucide-react";
import {
  ATTENTION_GROUP_BY_OPTIONS,
  ATTENTION_SORT_OPTIONS,
  buildAttentionFilterOptions,
  countActiveAttentionFilters,
  defaultAttentionFilterState,
  NO_GROUP_SENTINEL,
  sourceMeta,
  type AttentionFilterState,
  type AttentionGroupBy,
  type AttentionSortOrder,
} from "../lib/attention";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

const SEVERITY_LABELS: Record<string, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

interface DecisionsToolbarProps {
  /** Number of decisions currently shown, for the count pill. */
  visibleCount: number;
  filterOptions: ReturnType<typeof buildAttentionFilterOptions>;
  filters: AttentionFilterState;
  onFiltersChange: (next: AttentionFilterState) => void;
  groupBy: AttentionGroupBy;
  onGroupByChange: (next: AttentionGroupBy) => void;
  sortOrder: AttentionSortOrder;
  onSortOrderChange: (next: AttentionSortOrder) => void;
  /** Open the decision-training index. */
  onOpenTraining: () => void;
}

/**
 * The decisions filter / group / sort / training toolbar, shared verbatim by the
 * desk (WhatNeedsMe) and the per-queue page so both surfaces expose an identical
 * control set. All state lives in the parent; this is presentation
 * plus the filter popover only.
 */
export function DecisionsToolbar({
  visibleCount,
  filterOptions,
  filters,
  onFiltersChange,
  groupBy,
  onGroupByChange,
  sortOrder,
  onSortOrderChange,
  onOpenTraining,
}: DecisionsToolbarProps) {
  const activeFilterCount = countActiveAttentionFilters(filters);
  return (
    <div className="flex items-center gap-2">
      {visibleCount > 0 && (
        <span className="text-sm text-muted-foreground">
          {visibleCount} {visibleCount === 1 ? "decision" : "decisions"}
        </span>
      )}
      {/* Filter */}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className={cn("h-8 w-8 shrink-0", activeFilterCount > 0 && "bg-accent")}
            title="Filter"
            aria-label="Filter"
          >
            <ListFilter className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 p-0">
          <FilterMenu options={filterOptions} filters={filters} onChange={onFiltersChange} />
        </PopoverContent>
      </Popover>
      {/* Group by */}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className={cn("h-8 w-8 shrink-0", groupBy !== "none" && "bg-accent")}
            title="Group"
            aria-label="Group"
          >
            <Layers className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-40 p-2">
          <div className="space-y-0.5">
            {ATTENTION_GROUP_BY_OPTIONS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={cn(
                  "flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm",
                  groupBy === value ? "bg-accent/50 text-foreground" : "text-muted-foreground hover:bg-accent/50",
                )}
                onClick={() => onGroupByChange(value)}
              >
                <span>{label}</span>
                {groupBy === value ? <Check className="h-3.5 w-3.5" /> : null}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-8 w-8 shrink-0"
        title="Training"
        aria-label="Training"
        onClick={onOpenTraining}
      >
        <GraduationCap className="h-3.5 w-3.5" />
      </Button>
      {/* Sort */}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-8 w-8 shrink-0"
            title="Sort"
            aria-label="Sort"
          >
            <ArrowUpDown className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-44 p-2">
          <div className="space-y-0.5">
            {ATTENTION_SORT_OPTIONS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={cn(
                  "flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm",
                  sortOrder === value ? "bg-accent/50 text-foreground" : "text-muted-foreground hover:bg-accent/50",
                )}
                onClick={() => onSortOrderChange(value)}
              >
                <span>{label}</span>
                {sortOrder === value ? <Check className="h-3.5 w-3.5" /> : null}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function FilterMenu({
  options,
  filters,
  onChange,
}: {
  options: ReturnType<typeof buildAttentionFilterOptions>;
  filters: AttentionFilterState;
  onChange: (next: AttentionFilterState) => void;
}) {
  const toggle = (key: keyof AttentionFilterState, value: string) => {
    const list = filters[key] as string[];
    const nextList = list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
    onChange({ ...filters, [key]: nextList });
  };
  const hasActive = countActiveAttentionFilters(filters) > 0;

  return (
    <div className="max-h-(--sz-70vh) overflow-y-auto">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Filter</span>
        {hasActive && (
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={() => onChange(defaultAttentionFilterState)}
          >
            Clear
          </button>
        )}
      </div>

      {options.sourceKinds.length > 1 && (
        <FilterSection title="Type">
          {options.sourceKinds.map((kind) => (
            <FilterRow
              key={kind}
              label={sourceMeta(kind).label}
              checked={filters.sourceKinds.includes(kind)}
              onToggle={() => toggle("sourceKinds", kind)}
            />
          ))}
        </FilterSection>
      )}

      {options.severities.length > 1 && (
        <FilterSection title="Severity">
          {options.severities.map((severity) => (
            <FilterRow
              key={severity}
              label={SEVERITY_LABELS[severity] ?? severity}
              checked={filters.severities.includes(severity)}
              onToggle={() => toggle("severities", severity)}
            />
          ))}
        </FilterSection>
      )}

      {(options.projects.length > 0 || options.hasNoProject) && (
        <FilterSection title="Project">
          {options.projects.map((project) => (
            <FilterRow
              key={project.id}
              label={project.name}
              checked={filters.projectIds.includes(project.id)}
              onToggle={() => toggle("projectIds", project.id)}
            />
          ))}
          {options.hasNoProject && (
            <FilterRow
              label="No project"
              checked={filters.projectIds.includes(NO_GROUP_SENTINEL)}
              onToggle={() => toggle("projectIds", NO_GROUP_SENTINEL)}
            />
          )}
        </FilterSection>
      )}

      {(options.workspaces.length > 0 || options.hasNoWorkspace) && (
        <FilterSection title="Workspace">
          {options.workspaces.map((workspace) => (
            <FilterRow
              key={workspace.id}
              label={workspace.name}
              checked={filters.workspaceIds.includes(workspace.id)}
              onToggle={() => toggle("workspaceIds", workspace.id)}
            />
          ))}
          {options.hasNoWorkspace && (
            <FilterRow
              label="No workspace"
              checked={filters.workspaceIds.includes(NO_GROUP_SENTINEL)}
              onToggle={() => toggle("workspaceIds", NO_GROUP_SENTINEL)}
            />
          )}
        </FilterSection>
      )}
    </div>
  );
}

function FilterSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-t border-border/60 px-2 py-1.5">
      <p className="px-1 pb-1 text-(length:--text-nano) font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function FilterRow({
  label,
  checked,
  onToggle,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-sm px-1 py-1 text-left text-sm hover:bg-accent/50"
      onClick={onToggle}
    >
      <Checkbox checked={checked} className="pointer-events-none" tabIndex={-1} />
      <span className="truncate">{label}</span>
    </button>
  );
}
