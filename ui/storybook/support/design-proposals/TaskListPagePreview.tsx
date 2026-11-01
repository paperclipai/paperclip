import { useState } from "react";
import { ListChecks, SearchX } from "lucide-react";
import { CommandPalette } from "@/components/CommandPalette";
import { DesignSidebar } from "@/components/DesignSidebar";
import { DesignProposalAccess } from "./DesignProposalAccess";
import { initialItems, recentTasks } from "./task-page-data";
import { DesignPageShell } from "@/components/DesignPageShell";
import { EmptyState } from "@/components/EmptyState";
import { KanbanBoard } from "@/components/KanbanBoard";
import { NewIssueDialog } from "@/components/NewIssueDialog";
import { TaskList } from "@/components/TaskList";
import { TaskListToolbar } from "@/components/TaskListToolbar";
import { TruncatedTextMarqueeProvider } from "@/components/TruncatedText";
import { useCompany } from "@/context/CompanyContext";
import { useDialogActions } from "@/context/DialogContext";
import { useTaskListCollection } from "@/hooks/useTaskListCollection";
import { allTaskListColumns, defaultTaskListColumns } from "@/lib/task-list";
import { taskListViewStorageKey } from "@/lib/task-list-views";
import { storybookAgents, storybookAuthSession, storybookIssueLabels, storybookProjects } from "../../fixtures/paperclipData";

const currentUserId = storybookAuthSession.user.id;
const viewStorageKey = taskListViewStorageKey("design-proposals", currentUserId);

type PreviewProps = { allColumns?: boolean; initialQuery?: string };

export function TaskListPagePreview(props: PreviewProps) {
  return <DesignProposalAccess><TaskListPageContent {...props} /></DesignProposalAccess>;
}

/** Fixture controller only; the page consumes shared production components. */
function TaskListPageContent({ allColumns = false, initialQuery = "" }: PreviewProps) {
  const [items, setItems] = useState(initialItems);
  const { selectedCompanyId } = useCompany();
  const { openNewIssue } = useDialogActions();
  const { query, setQuery, view, setView, layout, setLayout, filters, updateFilters, clear,
    companyItems, matchingItems, visibleItems, creators, collapsedIds, setCollapsedIds,
    allExpanded, toggleExpanded, activeFilterCount, narrowed } = useTaskListCollection({
      items, companyId: selectedCompanyId, userId: currentUserId, viewStorageKey, initialQuery,
    });
  const emptyState = companyItems.length === 0
    ? <EmptyState icon={ListChecks} message="No tasks in this organization" description="This preview has task fixtures for Paperclip Storybook." />
    : <EmptyState icon={SearchX} message="No tasks match this view" description="Try another search or clear your filters." action="Clear filters" hideActionIcon onAction={clear} />;
  return (
    <TruncatedTextMarqueeProvider>
      <DesignPageShell title="Tasks" sidebar={<DesignSidebar recentTasks={recentTasks.map(item => item.issue)} onNewTask={() => openNewIssue()} />}>
        <TaskListToolbar
          view={view} onViewChange={setView}
          query={query} onQueryChange={setQuery}
          layout={layout} onLayoutChange={setLayout}
          allExpanded={allExpanded} onToggleExpanded={toggleExpanded}
          onNewTask={() => openNewIssue()}
          filters={{ state: filters, onChange: updateFilters, activeFilterCount, agents: storybookAgents, projects: storybookProjects, labels: storybookIssueLabels, currentUserId, creators }}
        />
        {narrowed ? <p className="design-task-results" role="status">{matchingItems.length} matching {matchingItems.length === 1 ? "task" : "tasks"}{visibleItems.length > matchingItems.length ? " · Parent tasks included for context" : ""}</p> : null}
        <div hidden={layout !== "list"} className="design-task-list-panel">
          <TaskList key={selectedCompanyId} items={visibleItems} allItems={companyItems} initialColumns={allColumns ? allTaskListColumns : defaultTaskListColumns} collapsedIds={collapsedIds} onCollapsedIdsChange={setCollapsedIds} emptyState={emptyState} />
        </div>
        {layout === "board" ? <div className="design-task-board">{matchingItems.length ? <KanbanBoard showOverflowFades issues={matchingItems.map(item => item.issue)} agents={storybookAgents} onUpdateIssue={(id, data) => setItems(current => current.map(item => item.issue.id === id ? { ...item, issue: { ...item.issue, ...data } } : item))} /> : emptyState}</div> : null}
      </DesignPageShell>
      <NewIssueDialog />
      <CommandPalette />
    </TruncatedTextMarqueeProvider>
  );
}
