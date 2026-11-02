import { useTranslation } from "@/i18n";
import type { ReactNode } from "react";
import { ArrowUpDown, Check, Columns3, Filter, Layers } from "lucide-react";
import type { CaseGroupBy, CaseSortField } from "@/api/cases";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CASE_COLUMNS, CASE_GROUP_OPTIONS, CASE_SORT_OPTIONS, DEFAULT_CASE_COLUMNS, type CaseColumn } from "@/lib/case-list-view";
import { cn } from "@/lib/utils";

const FIELD_LABEL_KEYS = {
  "identifier": "oct26Cases.field.identifier",
  "type": "oct26Cases.field.type",
  "project": "oct26Cases.field.project",
  "phase": "oct26Cases.field.phase",
  "assignee": "oct26Cases.field.assignee",
  "status": "oct26Cases.field.status",
  "updated": "oct26Cases.field.updated",
  "created": "oct26Cases.field.created",
  "title": "oct26Cases.field.title",
  "none": "oct26Cases.field.none"
} as const;

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
  const { t } = useTranslation();
  return <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="outline" size="icon" className="h-8 w-8 shrink-0" aria-label={t("oct26Cases.columns")} title={t("oct26Cases.columns")}><Columns3 aria-hidden className="h-3.5 w-3.5" /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel>{t("oct26Cases.visibleFields")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {CASE_COLUMNS.map(([key]) => <DropdownMenuCheckboxItem key={key} checked={columns.includes(key)}
          onSelect={event => event.preventDefault()}
          onCheckedChange={checked => onColumnsChange(CASE_COLUMNS.map(([value]) => value).filter(value => value === key ? checked === true : columns.includes(value)))}>{t(FIELD_LABEL_KEYS[key])}</DropdownMenuCheckboxItem>)}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onColumnsChange(DEFAULT_CASE_COLUMNS)}>{t("oct26Cases.resetDefaults")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <Popover>
      <PopoverTrigger asChild><Button variant="outline" size="icon" className={cn("relative h-8 w-8 shrink-0", activeFilterCount > 0 && "text-(--collection-filter-active)")}
        aria-label={activeFilterCount ? t("oct26Cases.activeFilters", { count: activeFilterCount }) : t("oct26Cases.filterCases")} title={t("oct26Cases.filter")}>
        <Filter aria-hidden className="h-3.5 w-3.5" />
        {activeFilterCount > 0 && <span aria-hidden className="absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-(--collection-filter-badge) text-(length:--text-nano) font-bold text-(--collection-filter-badge-foreground)">{activeFilterCount}</span>}
      </Button></PopoverTrigger>
      <PopoverContent align="end" className="w-64 space-y-3" aria-label={t("oct26Cases.caseFilters")}>
        <h2 className="text-sm font-medium">{t("oct26Cases.filters")}</h2>
        {filters}
      </PopoverContent>
    </Popover>
    <Popover>
      <PopoverTrigger asChild><Button variant="outline" size="icon" className="h-8 w-8 shrink-0" aria-label={t("oct26Cases.sort")} title={t("oct26Cases.sort")}><ArrowUpDown aria-hidden className="h-3.5 w-3.5" /></Button></PopoverTrigger>
      <PopoverContent align="end" className="w-48 p-2" aria-label={t("oct26Cases.sortCases")}>
        {CASE_SORT_OPTIONS.map(([value]) => <button key={value} type="button" aria-pressed={sortField === value}
          className={cn("flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm", sortField === value ? "bg-accent/50 text-foreground" : "text-muted-foreground hover:bg-accent/50")}
          onClick={() => onSortChange(value, sortField === value ? sortDir === "asc" ? "desc" : "asc" : "asc")}>
          <span>{t(FIELD_LABEL_KEYS[value])}</span>{sortField === value && <span aria-label={sortDir === "asc" ? t("oct26Cases.ascending") : t("oct26Cases.descending")} className="text-xs text-muted-foreground">{sortDir === "asc" ? "↑" : "↓"}</span>}
        </button>)}
      </PopoverContent>
    </Popover>
    <Popover>
      <PopoverTrigger asChild><Button variant="outline" size="icon" className={cn("h-8 w-8 shrink-0", groupBy !== "none" && "bg-accent")} aria-label={t("oct26Cases.group")} title={t("oct26Cases.group")}><Layers aria-hidden className="h-3.5 w-3.5" /></Button></PopoverTrigger>
      <PopoverContent align="end" className="w-44 p-2" aria-label={t("oct26Cases.groupCases")}>
        {CASE_GROUP_OPTIONS.map(([value]) => <button key={value} type="button" aria-pressed={groupBy === value}
          className={cn("flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm", groupBy === value ? "bg-accent/50 text-foreground" : "text-muted-foreground hover:bg-accent/50")}
          onClick={() => onGroupChange(value)}><span>{t(FIELD_LABEL_KEYS[value])}</span>{groupBy === value && <Check aria-hidden className="h-3.5 w-3.5" />}</button>)}
      </PopoverContent>
    </Popover>
  </>;
}
