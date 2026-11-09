import { ArrowUpDown, Check, Layers, Plus } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Link } from "@/lib/router";
import { ToolbarSearch } from "./ToolbarSearch";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

export type RoutineGroupBy = "folder" | "none" | "project" | "assignee";
export type RoutineSortField = "updated" | "created" | "title" | "lastRun";
export type RoutineSortDir = "asc" | "desc";

export function RoutinesToolbar({ query, onQueryChange, sortField, sortDir, groupBy, onSortChange, onGroupChange, onNewFolder, onCreateRoutine, tasksHref, selectMode, onToggleSelect }: {
  query: string;
  onQueryChange: (value: string) => void;
  sortField: RoutineSortField;
  sortDir: RoutineSortDir;
  groupBy: RoutineGroupBy;
  onSortChange: (field: RoutineSortField, direction: RoutineSortDir) => void;
  onGroupChange: (value: RoutineGroupBy) => void;
  onNewFolder?: () => void;
  onCreateRoutine: () => void;
  tasksHref?: string;
  selectMode?: boolean;
  onToggleSelect?: () => void;
}) {
  const { t } = useTranslation();

  const sortLabels: Record<RoutineSortField, string> = {
    updated: t("routines.toolbar.sortUpdated"),
    created: t("routines.toolbar.sortCreated"),
    lastRun: t("routines.toolbar.sortLastRun"),
    title: t("routines.toolbar.sortTitle"),
  };

  const groupLabels: Record<RoutineGroupBy, string> = {
    folder: t("routines.toolbar.groupFolder"),
    project: t("routines.toolbar.groupProject"),
    assignee: t("routines.toolbar.groupAssignee"),
    none: t("routines.toolbar.groupNone"),
  };

  return <div data-canonical-toolbar="routines" role="toolbar" aria-label={t("routines.toolbar.controlsAriaLabel")} className="flex flex-wrap items-center gap-4">
    <ToolbarSearch query={query} onQueryChange={onQueryChange} label={t("routines.toolbar.searchLabel")} placeholder={t("routines.toolbar.searchPlaceholder")} />
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" title={t("routines.toolbar.sort")}>
          <ArrowUpDown className="h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1" />
          <span>{t("routines.toolbar.sort")}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-44 p-0">
        <div className="p-2 space-y-0.5">
          {(["updated", "created", "lastRun", "title"] as const).map((field) => (
            <button
              type="button"
              key={field}
              className={`flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm ${
                sortField === field
                  ? "bg-accent/50 text-foreground"
                  : "text-muted-foreground hover:bg-accent/50"
              }`}
              onClick={() => {
                onSortChange(field, sortField === field
                  ? (sortDir === "asc" ? "desc" : "asc")
                  : (field === "title" ? "asc" : "desc"));
              }}
            >
              <span>{sortLabels[field]}</span>
              {sortField === field ? (
                <span className="text-xs text-muted-foreground">
                  {sortDir === "asc" ? t("routines.toolbar.sortAsc") : t("routines.toolbar.sortDesc")}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" title={t("routines.toolbar.group")}>
          <Layers className="h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1" />
          <span>{t("routines.toolbar.group")}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-44 p-0">
        <div className="p-2 space-y-0.5">
          {(["folder", "project", "assignee", "none"] as const).map((value) => (
            <button
              type="button"
              key={value}
              className={`flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm ${
                groupBy === value
                  ? "bg-accent/50 text-foreground"
                  : "text-muted-foreground hover:bg-accent/50"
              }`}
              onClick={() => onGroupChange(value)}
            >
              <span>{groupLabels[value]}</span>
              {groupBy === value ? <Check className="h-3.5 w-3.5" /> : null}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
    <div className="design-toolbar-actions">
      {onToggleSelect && <Button variant="outline" size="sm" onClick={onToggleSelect}>{selectMode ? t("routines.toolbar.done") : t("routines.toolbar.select")}</Button>}
      {tasksHref && <Button variant="outline" size="sm" asChild><Link data-toolbar-control to={tasksHref}>{t("routines.toolbar.viewAllTasks")}</Link></Button>}
      {onNewFolder && <Button variant="outline" size="sm" onClick={onNewFolder}><Plus className="h-4 w-4" />{t("routines.toolbar.newFolder")}</Button>}
      <Button variant="outline" size="sm" data-toolbar-primary onClick={onCreateRoutine}><Plus className="h-4 w-4" />{t("routines.list.createRoutine")}</Button>
    </div>
  </div>;
}
