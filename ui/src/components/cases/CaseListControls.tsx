import type { ReactNode } from "react";
import { ArrowUpDown, Check, Columns3, Filter, Layers } from "lucide-react";
import type { CaseGroupBy, CaseSortField } from "@/api/cases";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CASE_COLUMNS, CASE_GROUP_OPTIONS, CASE_SORT_OPTIONS, DEFAULT_CASE_COLUMNS, type CaseColumn } from "@/lib/case-list-view";
import { cn } from "@/lib/utils";

export function CaseListControls({ filters, activeFilterCount, columns, onColumnsChange, sortField, sortDir, onSortChange, groupBy, onGroupChange }: {
  filters: ReactNode;
  activeFilterCount: number;
  columns: readonly CaseColumn[];
  onColumnsChange: (columns: CaseColumn[]) => void;
  sortField: CaseSortField;
  sortDir: "asc" | "desc";
  onSortChange: (field: CaseSortField, direction: "asc" | "desc") => void;
  groupBy: CaseGroupBy;
  onGroupChange: (value: CaseGroupBy) => void;
}) {
  return <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="outline" size="icon" className="h-8 w-8 shrink-0" aria-label="Columns" title="Columns"><Columns3 aria-hidden className="h-3.5 w-3.5" /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel>Visible fields</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {CASE_COLUMNS.map(([key, label]) => <DropdownMenuCheckboxItem key={key} checked={columns.includes(key)}
          onSelect={event => event.preventDefault()}
          onCheckedChange={checked => onColumnsChange(CASE_COLUMNS.map(([value]) => value).filter(value => value === key ? checked === true : columns.includes(value)))}>{label}</DropdownMenuCheckboxItem>)}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onColumnsChange(DEFAULT_CASE_COLUMNS)}>Reset defaults</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <Popover>
      <PopoverTrigger asChild><Button variant="outline" size="icon" className={cn("relative h-8 w-8 shrink-0", activeFilterCount > 0 && "text-(--collection-filter-active)")}
        aria-label={activeFilterCount ? `Filter cases (${activeFilterCount} active)` : "Filter cases"} title="Filter">
        <Filter aria-hidden className="h-3.5 w-3.5" />
        {activeFilterCount > 0 && <span aria-hidden className="absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-(--collection-filter-badge) text-(length:--text-nano) font-bold text-(--collection-filter-badge-foreground)">{activeFilterCount}</span>}
      </Button></PopoverTrigger>
      <PopoverContent align="end" className="w-64 space-y-3" aria-label="Case filters">
        <h2 className="text-sm font-medium">Filters</h2>
        {filters}
      </PopoverContent>
    </Popover>
    <Popover>
      <PopoverTrigger asChild><Button variant="outline" size="icon" className="h-8 w-8 shrink-0" aria-label="Sort" title="Sort"><ArrowUpDown aria-hidden className="h-3.5 w-3.5" /></Button></PopoverTrigger>
      <PopoverContent align="end" className="w-48 p-2" aria-label="Sort cases">
        {CASE_SORT_OPTIONS.map(([value, label]) => <button key={value} type="button" aria-pressed={sortField === value}
          className={cn("flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm", sortField === value ? "bg-accent/50 text-foreground" : "text-muted-foreground hover:bg-accent/50")}
          onClick={() => onSortChange(value, sortField === value ? sortDir === "asc" ? "desc" : "asc" : "asc")}>
          <span>{label}</span>{sortField === value && <span aria-label={sortDir === "asc" ? "Ascending" : "Descending"} className="text-xs text-muted-foreground">{sortDir === "asc" ? "↑" : "↓"}</span>}
        </button>)}
      </PopoverContent>
    </Popover>
    <Popover>
      <PopoverTrigger asChild><Button variant="outline" size="icon" className={cn("h-8 w-8 shrink-0", groupBy !== "none" && "bg-accent")} aria-label="Group" title="Group"><Layers aria-hidden className="h-3.5 w-3.5" /></Button></PopoverTrigger>
      <PopoverContent align="end" className="w-44 p-2" aria-label="Group cases">
        {CASE_GROUP_OPTIONS.map(([value, label]) => <button key={value} type="button" aria-pressed={groupBy === value}
          className={cn("flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm", groupBy === value ? "bg-accent/50 text-foreground" : "text-muted-foreground hover:bg-accent/50")}
          onClick={() => onGroupChange(value)}><span>{label}</span>{groupBy === value && <Check aria-hidden className="h-3.5 w-3.5" />}</button>)}
      </PopoverContent>
    </Popover>
  </>;
}
