import { useState } from "react";
import { includeTaskListAncestors, type TaskListItem } from "@/components/TaskList";
import { applyIssueFilters, countActiveIssueFilters, defaultIssueFilterState, type IssueFilterState } from "@/lib/issue-filters";
import { loadTaskListView, matchesTaskListView, saveTaskListView, type TaskListView } from "@/lib/task-list-views";

type CreatorOption = { id: string; label: string; kind: "agent" | "user" };
const expanded: ReadonlySet<string> = new Set();

/** Shared collection behavior for the proposed task UI. Supply accessible data;
 * this hook scopes presentation, and does not replace server authorization. */
export function useTaskListCollection({ items, companyId, userId, viewStorageKey, initialQuery = "" }: {
  items: readonly TaskListItem[];
  companyId: string | null;
  userId: string | null;
  viewStorageKey: string;
  initialQuery?: string;
}) {
  const [query, setQueryState] = useState(initialQuery);
  const [preference, setPreference] = useState(() => ({ key: viewStorageKey, view: loadTaskListView(viewStorageKey) }));
  const view = preference.key === viewStorageKey ? preference.view : loadTaskListView(viewStorageKey);
  const [layout, setLayout] = useState<"list" | "board">("list");
  const [filters, setFilters] = useState<IssueFilterState>(defaultIssueFilterState);
  const [collapse, setCollapse] = useState({ companyId, ids: expanded });
  const collapsedIds = collapse.companyId === companyId ? collapse.ids : expanded;
  const setCollapsedIds = (ids: ReadonlySet<string>) => setCollapse({ companyId, ids });
  const resetExpansion = () => setCollapsedIds(expanded);

  const companyItems = items.filter(item => item.issue.companyId === companyId);
  const creatorsById = new Map<string, CreatorOption>();
  for (const item of companyItems) {
    const { createdByAgentId, createdByUserId } = item.issue;
    const rawId = createdByAgentId ?? createdByUserId;
    if (!rawId) continue;
    const kind = createdByAgentId ? "agent" : "user";
    const id = `${kind}:${rawId}`;
    creatorsById.set(id, { id, kind, label: item.createdBy || rawId });
  }
  const filteredIds = new Set(applyIssueFilters(companyItems.map(item => item.issue), filters, userId).map(issue => issue.id));
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matchingItems = companyItems.filter(item => filteredIds.has(item.issue.id)
    && matchesTaskListView(view, item.issue, Boolean(item.unread), userId)
    && [item.issue.title, item.issue.identifier, item.createdBy, item.assignee, item.issue.project?.name,
      ...(item.issue.labels ?? []).map(label => label.name)].some(value => value?.toLocaleLowerCase().includes(normalizedQuery)));
  const visibleItems = includeTaskListAncestors(companyItems, matchingItems);
  const parentIds = new Set(companyItems.flatMap(item => item.issue.parentId ? [item.issue.parentId] : []));
  const allExpanded = ![...parentIds].some(id => collapsedIds.has(id));
  const activeFilterCount = countActiveIssueFilters(filters);

  const setQuery = (next: string) => { setQueryState(next); resetExpansion(); };
  const setView = (next: TaskListView) => {
    setPreference({ key: viewStorageKey, view: next });
    saveTaskListView(viewStorageKey, next);
    resetExpansion();
  };
  const updateFilters = (patch: Partial<IssueFilterState>) => {
    setFilters(current => ({ ...current, ...patch }));
    resetExpansion();
  };
  const clear = () => { setQuery(""); setFilters(defaultIssueFilterState); setView("all"); };

  return {
    query, setQuery, view, setView, layout, setLayout, filters, updateFilters, clear,
    companyItems, matchingItems, visibleItems, creators: [...creatorsById.values()],
    collapsedIds, setCollapsedIds, allExpanded,
    toggleExpanded: () => setCollapsedIds(allExpanded ? parentIds : expanded),
    activeFilterCount, narrowed: Boolean(normalizedQuery || activeFilterCount || view !== "all"),
  };
}
