import { t, useTranslation } from "@/i18n";
import type { ComponentProps, ReactNode, Ref } from "react";
import { ChevronDown, CirclePlus, Columns3, List, ListTree } from "lucide-react";
import { IssueFiltersPopover } from "./IssueFiltersPopover";
import { Button } from "./ui/button";
import { ToolbarSearch } from "./ToolbarSearch";
import { FlyoutHeader, FlyoutOptions } from "./ui/flyout";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { taskListViews as views, type TaskListView } from "@/lib/task-list-views";

/** Canonical proposed task toolbar; review under Components / Toolbars / Tasks. */
export function TaskListToolbar({ view, onViewChange, viewOptions = views, viewControl, query, onQueryChange, searchRef, layout, onLayoutChange, allExpanded, onToggleExpanded, onNewTask, filters }: {
  view: TaskListView;
  onViewChange: (view: TaskListView) => void;
  viewOptions?: readonly { value: TaskListView; label: string }[];
  viewControl?: ReactNode;
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
  useTranslation("task-components");
  return (
    <div data-canonical-toolbar="tasks" className="design-page-toolbar" role="toolbar" aria-label={t("task-components:taskListControls_515af175")}>
      {viewControl ?? <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="outline" className="design-toolbar-button design-view-trigger" aria-label={`Task view: ${viewOptions.find(option => option.value === view)!.label}`}>{viewOptions.find(option => option.value === view)!.label}<ChevronDown aria-hidden /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="task-list-options" aria-label={t("task-components:taskViews_eb704b63")}>
          <DropdownMenuLabel asChild><FlyoutHeader className="task-list-options-heading">{t("task-components:views_69c40459")}</FlyoutHeader></DropdownMenuLabel>
          <DropdownMenuRadioGroup asChild value={view} onValueChange={value => onViewChange(value as TaskListView)}><FlyoutOptions className="task-list-options-items">
            {viewOptions.map(option => <DropdownMenuRadioItem className="task-list-options-item" key={option.value} value={option.value}>{option.label}</DropdownMenuRadioItem>)}
          </FlyoutOptions></DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>}
      <ToolbarSearch query={query} onQueryChange={onQueryChange} inputRef={searchRef} label={t("task-components:searchTasks_46c6f1de")} placeholder={t("task-components:searchTasks_945d1c21")} />
      <div className="design-view-toggle" role="group" aria-label={t("task-components:taskLayout_9d37eff2")}>
        {[{ value: "list", label: t("deep-ui:list_view_5d8c3e"), icon: List }, { value: "board", label: t("task-components:boardView_04b1c2e0"), icon: Columns3 }].map(({ value, label, icon: Icon }) => (
          <Tooltip key={value}><TooltipTrigger asChild><Button variant="ghost" className="design-toolbar-button design-toolbar-icon" aria-label={label} aria-pressed={layout === value} onClick={() => onLayoutChange(value as "list" | "board")}><Icon aria-hidden /></Button></TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>
        ))}
      </div>
      <div className="design-toolbar-actions">
        <Tooltip><TooltipTrigger asChild><Button variant="outline" className="design-toolbar-button design-toolbar-icon" disabled={layout !== "list"} aria-label={allExpanded ? t("task-components:collapseAllTasks_87bb61db") : t("task-components:expandAllTasks_91d62927")} onClick={onToggleExpanded}><ListTree aria-hidden /></Button></TooltipTrigger><TooltipContent>{allExpanded ? t("task-components:collapseAllTasks_87bb61db") : t("task-components:expandAllTasks_91d62927")}</TooltipContent></Tooltip>
        <div className="design-toolbar-filter"><IssueFiltersPopover {...filters} presentation="refreshed" buttonVariant="outline" iconOnly enableExternalObjectFilters={false} /></div>
        <Button className="design-toolbar-button design-new-task" onClick={onNewTask}><CirclePlus aria-hidden />{t("deep-ui:toolbar_new_task")}</Button>
      </div>
    </div>
  );
}
