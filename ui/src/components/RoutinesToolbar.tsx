import { ArrowUpDown, Check, Layers, Plus } from "lucide-react";
import { Link } from "@/lib/router";
import { ToolbarSearch } from "./ToolbarSearch";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

export type RoutineGroupBy = "folder" | "none" | "project" | "assignee";
export type RoutineSortField = "updated" | "created" | "title" | "lastRun";
export type RoutineSortDir = "asc" | "desc";

export function RoutinesToolbar({ query, onQueryChange, sortField, sortDir, groupBy, onSortChange, onGroupChange, onNewFolder, onCreateRoutine, runsHref, selectMode, onToggleSelect }: {
  query: string;
  onQueryChange: (value: string) => void;
  sortField: RoutineSortField;
  sortDir: RoutineSortDir;
  groupBy: RoutineGroupBy;
  onSortChange: (field: RoutineSortField, direction: RoutineSortDir) => void;
  onGroupChange: (value: RoutineGroupBy) => void;
  onNewFolder?: () => void;
  onCreateRoutine: () => void;
  runsHref?: string;
  selectMode?: boolean;
  onToggleSelect?: () => void;
}) {
  return <div data-canonical-toolbar="routines" role="toolbar" aria-label="Routines controls" className="flex flex-wrap items-center gap-4">
    <ToolbarSearch query={query} onQueryChange={onQueryChange} label="Search routines" placeholder="Search routines…" />
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" title="Sort">
          <ArrowUpDown className="h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1" />
          <span >Sort</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-44 p-0">
        <div className="p-2 space-y-0.5">
          {([
            ["updated", "Updated"],
            ["created", "Created"],
            ["lastRun", "Last run"],
            ["title", "Title"],
          ] as const).map(([field, label]) => (
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
              <span>{label}</span>
              {sortField === field ? (
                <span className="text-xs text-muted-foreground">
                  {sortDir === "asc" ? "Asc" : "Desc"}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" title="Group">
          <Layers className="h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1" />
          <span >Group</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-44 p-0">
        <div className="p-2 space-y-0.5">
          {([
            ["folder", "Folder"],
            ["project", "Project"],
            ["assignee", "Agent"],
            ["none", "None"],
          ] as const).map(([value, label]) => (
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
              <span>{label}</span>
              {groupBy === value ? <Check className="h-3.5 w-3.5" /> : null}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
    <div className="design-toolbar-actions">
      {onToggleSelect && <Button variant="outline" size="sm" onClick={onToggleSelect}>{selectMode ? "Done" : "Select"}</Button>}
      {runsHref && <Button variant="outline" size="sm" asChild><Link data-toolbar-control to={runsHref}>View all runs</Link></Button>}
      {onNewFolder && <Button variant="outline" size="sm" onClick={onNewFolder}><Plus className="h-4 w-4" />New folder</Button>}
      <Button variant="outline" size="sm" data-toolbar-primary onClick={onCreateRoutine}><Plus className="h-4 w-4" />Create routine</Button>
    </div>
  </div>;
}
