import { useState } from "react";
import { ListTodo } from "lucide-react";
import { CommandPalette } from "@/components/CommandPalette";
import { DesignPageShell } from "@/components/DesignPageShell";
import { DesignSidebar } from "@/components/DesignSidebar";
import { EmptyState } from "@/components/EmptyState";
import { KanbanBoard } from "@/components/KanbanBoard";
import { NewIssueDialog } from "@/components/NewIssueDialog";
import { TaskList } from "@/components/TaskList";
import { TaskListToolbar } from "@/components/TaskListToolbar";
import { useCompany } from "@/context/CompanyContext";
import { useDialogActions } from "@/context/DialogContext";
import { useTaskListCollection } from "@/hooks/useTaskListCollection";
import { taskListViewStorageKey } from "@/lib/task-list-views";
import { storybookAgents, storybookAuthSession, storybookIssueLabels, storybookProjects } from "../../fixtures/paperclipData";
import { DesignProposalAccess } from "./DesignProposalAccess";
import { initialItems, recentTasks } from "./task-page-data";

const scope = "design-agent-task-list-trial-2";
const sidebarRecents = recentTasks.map(item => item.issue);

function TrialContent() {
  const [items, setItems] = useState(initialItems);
  const { selectedCompanyId } = useCompany();
  const { openNewIssue } = useDialogActions();
  const userId = storybookAuthSession.user.id;
  const collection = useTaskListCollection({
    items, companyId: selectedCompanyId, userId,
    viewStorageKey: taskListViewStorageKey(scope, userId),
  });
  const newTask = () => openNewIssue();
  const emptyState = <EmptyState
    icon={ListTodo}
    message={collection.companyItems.length ? "No tasks match this view" : "No tasks in this organization"}
    action={collection.companyItems.length ? "Clear filters" : "New Task"}
    onAction={collection.companyItems.length ? collection.clear : newTask}
  />;

  return <>
    <DesignPageShell title="Tasks" sidebarStorageKey={`${scope}.sidebar-width`}
      sidebar={<DesignSidebar recentTasks={sidebarRecents} onNewTask={newTask} />}>
      <TaskListToolbar
        view={collection.view} onViewChange={collection.setView}
        query={collection.query} onQueryChange={collection.setQuery}
        layout={collection.layout} onLayoutChange={collection.setLayout}
        allExpanded={collection.allExpanded} onToggleExpanded={collection.toggleExpanded}
        onNewTask={newTask}
        filters={{
          state: collection.filters, onChange: collection.updateFilters,
          activeFilterCount: collection.activeFilterCount, creators: collection.creators,
          currentUserId: userId, agents: storybookAgents,
          projects: storybookProjects, labels: storybookIssueLabels,
        }}
      />
      {collection.narrowed ? <p className="design-task-results" role="status">
        {collection.matchingItems.length} matching {collection.matchingItems.length === 1 ? "task" : "tasks"}
        {collection.layout === "list" && collection.visibleItems.length > collection.matchingItems.length ? " · Parent tasks included for context" : ""}
      </p> : null}
      {/* Preserve the shared table's column/sort state while the board is active. */}
      <div className="design-task-list-panel" hidden={collection.layout !== "list"}>
        <TaskList items={collection.visibleItems} allItems={collection.companyItems}
          collapsedIds={collection.collapsedIds} onCollapsedIdsChange={collection.setCollapsedIds}
          emptyState={emptyState} />
      </div>
      {collection.layout === "board" ? <div className="design-task-board">
        {collection.matchingItems.length ? <KanbanBoard
          issues={collection.matchingItems.map(item => item.issue)} agents={storybookAgents} showOverflowFades
          onUpdateIssue={(id, patch) => setItems(current => current.map(item => item.issue.id === id
            ? { ...item, issue: { ...item.issue, ...patch } } : item))}
        /> : emptyState}
      </div> : null}
    </DesignPageShell>
    <NewIssueDialog />
    <CommandPalette />
  </>;
}

/** Independent composition; collection transitions remain owned by the shared hook. */
export function TasksReproductionTrial2() {
  return <DesignProposalAccess><TrialContent /></DesignProposalAccess>;
}
