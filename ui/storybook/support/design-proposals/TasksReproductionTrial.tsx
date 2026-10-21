import { useState } from "react";
import { ListChecks, SearchX } from "lucide-react";
import { CommandPalette } from "@/components/CommandPalette";
import { DesignPageShell } from "@/components/DesignPageShell";
import { DesignSidebar } from "@/components/DesignSidebar";
import { EmptyState } from "@/components/EmptyState";
import { KanbanBoard } from "@/components/KanbanBoard";
import { NewIssueDialog } from "@/components/NewIssueDialog";
import { TaskList, type TaskListItem } from "@/components/TaskList";
import { TaskListToolbar } from "@/components/TaskListToolbar";
import { useCompany } from "@/context/CompanyContext";
import { useDialogActions } from "@/context/DialogContext";
import { useTaskListCollection } from "@/hooks/useTaskListCollection";
import { TruncatedTextMarqueeProvider } from "@/components/TruncatedText";
import { taskListViewStorageKey } from "@/lib/task-list-views";
import { storybookAgents, storybookIssueLabels, storybookProjects } from "../../fixtures/paperclipData";
import { DesignProposalAccess } from "./DesignProposalAccess";
import { initialItems, recentTasks } from "./task-page-data";

// Controller only: all visual composition comes from the shared proposal system.
const userId = "user-board";
const viewKey = taskListViewStorageKey("design-agent-task-list-trial", userId);

function TrialContent() {
  const { selectedCompanyId } = useCompany();
  const { openNewIssue } = useDialogActions();
  const [items, setItems] = useState<TaskListItem[]>(initialItems);
  const { query, setQuery, view, setView, layout, setLayout, filters, updateFilters, clear,
    companyItems, matchingItems: matches, visibleItems, creators, collapsedIds, setCollapsedIds,
    allExpanded, toggleExpanded, activeFilterCount, narrowed } = useTaskListCollection({
      items, companyId: selectedCompanyId, userId, viewStorageKey: viewKey,
    });
  const emptyState = companyItems.length === 0
    ? <EmptyState icon={ListChecks} message="No tasks in this organization" description="This preview has task fixtures for Paperclip Storybook." />
    : <EmptyState icon={SearchX} message="No tasks match this view" description="Try another search or clear your filters." action="Clear filters" hideActionIcon onAction={clear} />;

  return <TruncatedTextMarqueeProvider>
    <DesignPageShell title="Tasks" sidebarStorageKey="paperclip.design-agent-task-list-trial.sidebar-width"
      sidebar={<DesignSidebar recentTasks={recentTasks.map(item => item.issue)} onNewTask={() => openNewIssue()} />}>
      <TaskListToolbar view={view} onViewChange={setView}
        query={query} onQueryChange={setQuery} layout={layout} onLayoutChange={setLayout}
        allExpanded={allExpanded} onToggleExpanded={toggleExpanded}
        onNewTask={() => openNewIssue()}
        filters={{ state: filters, onChange: updateFilters, activeFilterCount,
          agents: storybookAgents, projects: storybookProjects, labels: storybookIssueLabels, currentUserId: userId,
          creators,
        }} />
      {narrowed ? <p className="design-task-results" role="status">{matches.length} matching task{matches.length === 1 ? "" : "s"}{visibleItems.length > matches.length ? " · Parent tasks included for context" : ""}</p> : null}
      <section className="design-task-list-panel" hidden={layout !== "list"} aria-label="Tasks">
        <TaskList key={selectedCompanyId} items={visibleItems} allItems={companyItems} collapsedIds={collapsedIds} onCollapsedIdsChange={setCollapsedIds} emptyState={emptyState} />
      </section>
      {layout === "board" ? <section className="design-task-board" aria-label="Task board">
        {matches.length ? <KanbanBoard issues={matches.map(item => item.issue)} agents={storybookAgents} showOverflowFades
          onUpdateIssue={(id, patch) => setItems(current => current.map(item => item.issue.id === id ? { ...item, issue: { ...item.issue, ...patch } } : item))} /> : emptyState}
      </section> : null}
    </DesignPageShell>
    <NewIssueDialog />
    <CommandPalette />
  </TruncatedTextMarqueeProvider>;
}

export function TasksReproductionTrial() {
  return <DesignProposalAccess><TrialContent /></DesignProposalAccess>;
}
