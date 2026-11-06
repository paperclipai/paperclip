import { t, useTranslation, Trans } from "@/i18n";
import { ArrowUpDown, Check, Plus } from "lucide-react";
import { ToolbarSearch } from "./ToolbarSearch";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

export type ProjectSortField = "name" | "updated" | "created" | "targetDate";
export type ProjectSortDir = "asc" | "desc";

const PROJECT_SORT_OPTIONS: Array<{ field: ProjectSortField; label: string }> = [
  { field: "name", get label() { return t("task-components:name_dcd1d522"); } },
  { field: "updated", get label() { return t("task-components:updated_3a5ecca1"); } },
  { field: "created", get label() { return t("task-components:created_d70b9e24"); } },
  { field: "targetDate", get label() { return t("task-components:targetDate_834cc86b"); } },
];

/** Canonical project search, sorting and creation controls. State stays with the page. */
export function ProjectsToolbar({ query, onQueryChange, sortField, sortDir, onSortChange, onNewProject: openNewProject }: {
  query: string;
  onQueryChange: (value: string) => void;
  sortField: ProjectSortField;
  sortDir: ProjectSortDir;
  onSortChange: (field: ProjectSortField, direction: ProjectSortDir) => void;
  onNewProject: () => void;
}) {
  useTranslation("task-components");
  const sortLabel = PROJECT_SORT_OPTIONS.find(option => option.field === sortField)?.label ?? t("task-components:name_dcd1d522");
  return <div data-canonical-toolbar="projects" role="toolbar" aria-label={t("task-components:projectsControls_42967940")} className="flex flex-wrap items-center gap-4">
    <ToolbarSearch query={query} onQueryChange={onQueryChange} label={t("task-components:searchProjects_9e079c7d")} placeholder={t("task-components:searchProjects_b0c5facf")} />
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" title={t("task-components:sort_bec69036")}>
          <ArrowUpDown className="h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1" />
          <span><Trans ns="task-components" i18nKey="sentence_54849d28ae1b" components={{ part1: <>{sortLabel}</> }} /></span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-44 p-0">
        <div className="p-2 space-y-0.5">
          {PROJECT_SORT_OPTIONS.map((option) => (
            <button
              key={option.field}
              type="button"
              className={`flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm ${
                sortField === option.field
                  ? "bg-accent/50 text-foreground"
                  : "text-muted-foreground hover:bg-accent/50"
              }`}
              onClick={() => {
                onSortChange(option.field, sortField === option.field
                  ? (sortDir === "asc" ? "desc" : "asc")
                  : (option.field === "name" || option.field === "targetDate" ? "asc" : "desc"));
              }}
            >
              <span>{option.label}</span>
              {sortField === option.field ? (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Check className="h-3 w-3" />
                  {sortDir === "asc" ? t("task-components:asc_cddeba5c") : t("task-components:desc_5c4419a6")}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
    <div className="design-toolbar-actions">
      <Button size="sm" variant="outline" data-toolbar-primary onClick={openNewProject}>
          <Plus className="h-4 w-4 mr-1" />
          {t("work:createProject")}
      </Button>
    </div>
  </div>;
}
