import { toolbarLabel } from "@/lib/toolbar-localization";
import { t, useTranslation } from "@/i18n";
import type { ComponentProps, Ref } from "react";
import { ChevronDown, CirclePlus, Columns3, List, ListTree } from "lucide-react";
import { IssueFiltersPopover } from "./IssueFiltersPopover";
import { Button } from "./ui/button";
import { ToolbarSearch } from "./ToolbarSearch";
import { FlyoutHeader, FlyoutOptions } from "./ui/flyout";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { taskListViews as views, type TaskListView } from "@/lib/task-list-views";

/** Canonical proposed task toolbar; review under Components / Toolbars / Tasks. */
export function TaskListToolbar({ view, onViewChange, query, onQueryChange, searchRef, layout, onLayoutChange, allExpanded, onToggleExpanded, onNewTask, filters }: {
  view: TaskListView;
  onViewChange: (view: TaskListView) => void;
  query: string;
  onQueryChange: (query: string) => void;
  searchRef?: Ref<HTMLInputElement>;
  layout: "list" | "board";
  onLayoutChange: (layout: "list" | "board") => void;
  allExpanded: boolean;
  onToggleExpanded: () => void;
  onNewTask: () => void;
  filters: ComponentProps<typeof IssueFiltersPopover>;
}) {
  useTranslation();
  return (
    <div data-canonical-toolbar="tasks" className="design-page-toolbar" role="toolbar" aria-label={t("oct26Toolbar.taskControls")}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="outline" className="design-toolbar-button design-view-trigger" aria-label={t("oct26Toolbar.taskView", { view: toolbarLabel(views.find(option => option.value === view)!.label) })}>{toolbarLabel(views.find(option => option.value === view)!.label)}<ChevronDown aria-hidden /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="task-list-options" aria-label={t("oct26Toolbar.taskViews")}>
          <DropdownMenuLabel asChild><FlyoutHeader className="task-list-options-heading">{t("oct26Toolbar.views")}</FlyoutHeader></DropdownMenuLabel>
          <DropdownMenuRadioGroup asChild value={view} onValueChange={value => onViewChange(value as TaskListView)}><FlyoutOptions className="task-list-options-items">
            {views.map(option => <DropdownMenuRadioItem className="task-list-options-item" key={option.value} value={option.value}>{toolbarLabel(option.label)}</DropdownMenuRadioItem>)}
          </FlyoutOptions></DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <ToolbarSearch query={query} onQueryChange={onQueryChange} inputRef={searchRef} label={t("oct26Toolbar.searchTasks")} placeholder={t("oct26Toolbar.searchTasksPlaceholder")} />
      <div className="design-view-toggle" role="group" aria-label={t("oct26Toolbar.taskLayout")}>
        {[{ value: "list", label: t("oct26Toolbar.listView"), icon: List }, { value: "board", label: t("oct26Toolbar.boardView"), icon: Columns3 }].map(({ value, label, icon: Icon }) => (
          <Tooltip key={value}><TooltipTrigger asChild><Button variant="ghost" className="design-toolbar-button design-toolbar-icon" aria-label={label} aria-pressed={layout === value} onClick={() => onLayoutChange(value as "list" | "board")}><Icon aria-hidden /></Button></TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>
        ))}
      </div>
      <div className="design-toolbar-actions">
        <Tooltip><TooltipTrigger asChild><Button variant="outline" className="design-toolbar-button design-toolbar-icon" disabled={layout !== "list"} aria-label={allExpanded ? t("oct26Toolbar.collapseTasks") : t("oct26Toolbar.expandTasks")} onClick={onToggleExpanded}><ListTree aria-hidden /></Button></TooltipTrigger><TooltipContent>{allExpanded ? t("oct26Toolbar.collapseTasks") : t("oct26Toolbar.expandTasks")}</TooltipContent></Tooltip>
        <div className="design-toolbar-filter"><IssueFiltersPopover {...filters} presentation="refreshed" buttonVariant="outline" iconOnly enableExternalObjectFilters={false} /></div>
        <Button className="design-toolbar-button design-new-task" onClick={onNewTask}><CirclePlus aria-hidden />{t("oct26Toolbar.newTask")}</Button>
      </div>
    </div>
  );
}
