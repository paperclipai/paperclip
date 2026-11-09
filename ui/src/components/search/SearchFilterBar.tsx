import { useMemo } from "react";
import { User, UserX } from "lucide-react";
import {
  COMPANY_SEARCH_UPDATED_WITHIN_OPTIONS,
  ISSUE_PRIORITIES,
  ISSUE_DISPLAY_STATUSES,
  type CompanySearchFilterOptionCounts,
  type CompanySearchSort,
  type IssueDisplayStatus,
} from "@paperclipai/shared";
import { StatusIcon } from "@/components/StatusIcon";
import { PriorityIcon } from "@/components/PriorityIcon";
import { SHOW_TASK_PRIORITY_UI } from "@/lib/ui-flags";
import { t as translate, useTranslation } from "@/i18n";
import { SearchFilterMenu, type FilterMenuOption } from "./SearchFilterMenu";
import { SearchSortMenu } from "./SearchSortMenu";
import {
  applyAssigneeToken,
  assigneeToken,
  updatedWithinLabel,
  type SearchFilters,
} from "@/lib/search-filters";

export interface SearchFilterAgent {
  id: string;
  name: string;
}
export interface SearchFilterProject {
  id: string;
  name: string;
}
export interface SearchFilterLabel {
  id: string;
  name: string;
  color: string;
}

export interface SearchFilterDataProps {
  counts?: CompanySearchFilterOptionCounts;
  agents: SearchFilterAgent[];
  projects: SearchFilterProject[];
  labels: SearchFilterLabel[];
  currentUserId: string | null;
}

// Non-terminal statuses — the single-click "Open items" preset from wireframe screen 2.
const OPEN_STATUS_PRESET: IssueDisplayStatus[] = ISSUE_DISPLAY_STATUSES.filter(
  (status) => status !== "done" && status !== "cancelled",
);

const STATUS_LABEL_KEY: Record<IssueDisplayStatus, string> = {
  backlog: "search.filterBar.statusValues.backlog",
  todo: "search.filterBar.statusValues.todo",
  in_progress: "search.filterBar.statusValues.in_progress",
  monitoring: "search.filterBar.statusValues.monitoring",
  in_review: "search.filterBar.statusValues.in_review",
  done: "common.done",
  blocked: "search.filterBar.statusValues.blocked",
  cancelled: "search.filterBar.statusValues.cancelled",
};

const PRIORITY_LABEL_KEY: Record<string, string> = {
  critical: "search.filterBar.priorityValues.critical",
  high: "search.filterBar.priorityValues.high",
  medium: "search.filterBar.priorityValues.medium",
  low: "search.filterBar.priorityValues.low",
};

function enumLabel(keys: Record<string, string>, value: string): string {
  const key = keys[value];
  return key ? translate(key) : humanize(value);
}

function humanize(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function count(record: Record<string, number> | undefined, key: string): number | undefined {
  return record?.[key];
}

export interface SearchFilterOptionGroups {
  status: FilterMenuOption[];
  priority: FilterMenuOption[];
  assignee: FilterMenuOption[];
  project: FilterMenuOption[];
  label: FilterMenuOption[];
  updated: FilterMenuOption[];
}

/** Build option lists (with filter-aware counts) shared by the desktop bar and mobile sheet. */
export function buildSearchFilterOptions({
  counts,
  agents,
  projects,
  labels,
  currentUserId,
}: SearchFilterDataProps): SearchFilterOptionGroups {
  const status: FilterMenuOption[] = ISSUE_DISPLAY_STATUSES.map((value) => ({
    value,
    label: enumLabel(STATUS_LABEL_KEY, value),
    icon: <StatusIcon status={value} />,
    count: count((counts?.displayStatus ?? counts?.status) as Record<string, number> | undefined, value),
  }));

  const priority: FilterMenuOption[] = ISSUE_PRIORITIES.map((value) => ({
    value,
    label: enumLabel(PRIORITY_LABEL_KEY, value),
    icon: <PriorityIcon priority={value} />,
    count: count(counts?.priority as Record<string, number> | undefined, value),
  }));

  const assignee: FilterMenuOption[] = [];
  if (currentUserId) {
    assignee.push({
      value: "me",
      label: translate("search.filterBar.me"),
      icon: <User className="h-3.5 w-3.5 text-muted-foreground" />,
      count: count(counts?.assigneeUserId, currentUserId),
      searchText: translate("search.filterBar.meSearch"),
    });
  }
  assignee.push({
    value: "none",
    label: translate("search.filterBar.unassigned"),
    icon: <UserX className="h-3.5 w-3.5 text-muted-foreground" />,
    searchText: translate("search.filterBar.unassignedSearch"),
  });
  for (const agent of agents) {
    assignee.push({
      value: `agent:${agent.id}`,
      label: agent.name,
      count: count(counts?.assigneeAgentId, agent.id),
      searchText: agent.name,
    });
  }

  const project: FilterMenuOption[] = projects.map((item) => ({
    value: item.id,
    label: item.name,
    count: count(counts?.projectId, item.id),
    searchText: item.name,
  }));

  const label: FilterMenuOption[] = labels.map((item) => ({
    value: item.id,
    label: item.name,
    swatch: item.color,
    count: count(counts?.labelId, item.id),
    searchText: item.name,
  }));

  const updated: FilterMenuOption[] = COMPANY_SEARCH_UPDATED_WITHIN_OPTIONS.map((value) => ({
    value,
    label: updatedWithinLabel(value),
    count: count(counts?.updatedWithin as Record<string, number> | undefined, value),
  }));

  return { status, priority, assignee, project, label, updated };
}

export function SearchFilterBar({
  filters,
  onChange,
  sort,
  onSortChange,
  data,
}: {
  filters: SearchFilters;
  onChange: (next: SearchFilters) => void;
  sort: CompanySearchSort;
  onSortChange: (next: CompanySearchSort) => void;
  data: SearchFilterDataProps;
}) {
  const { t } = useTranslation();
  const options = useMemo(() => buildSearchFilterOptions(data), [data]);

  function toggleMulti(dimension: "status" | "priority", value: string) {
    const current = (filters[dimension] ?? []) as string[];
    const next = current.includes(value)
      ? current.filter((entry) => entry !== value)
      : [...current, value];
    onChange({ ...filters, [dimension]: next });
  }

  const selectedAssignee = assigneeToken(filters, data.currentUserId);

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="search-filter-bar">
      <SearchFilterMenu
        label={t("common.status")}
        multi
        options={options.status}
        selected={filters.status ?? []}
        onToggle={(value) => toggleMulti("status", value)}
        onClear={() => onChange({ ...filters, status: [] })}
        presets={[{ label: t("search.filterBar.openItems"), values: OPEN_STATUS_PRESET }]}
      />
      <SearchFilterMenu
        label={t("search.filterBar.assigneeLabel")}
        options={options.assignee}
        selected={selectedAssignee ? [selectedAssignee] : []}
        onSelect={(value) => onChange(applyAssigneeToken(filters, value, data.currentUserId))}
        searchable
        searchPlaceholder={t("search.filterBar.searchAssignees")}
        emptyMessage={t("search.filterBar.noAssignees")}
      />
      <SearchFilterMenu
        label={t("search.filterBar.projectLabel")}
        options={options.project}
        selected={filters.projectId ? [filters.projectId] : []}
        onSelect={(value) => onChange({ ...filters, projectId: value })}
        searchable
        searchPlaceholder={t("search.filterBar.searchProjects")}
        emptyMessage={t("search.filterBar.noProjects")}
      />
      <SearchFilterMenu
        label={t("search.filterBar.labelLabel")}
        options={options.label}
        selected={filters.labelId ? [filters.labelId] : []}
        onSelect={(value) => onChange({ ...filters, labelId: value })}
        searchable
        searchPlaceholder={t("search.filterBar.searchLabels")}
        emptyMessage={t("search.filterBar.noLabels")}
      />
      {/* PAP-411: Priority filter menu hidden behind SHOW_TASK_PRIORITY_UI (search DSL stays intact). */}
      {SHOW_TASK_PRIORITY_UI && (
      <SearchFilterMenu
        label={t("search.filterBar.priorityLabel")}
        multi
        options={options.priority}
        selected={filters.priority ?? []}
        onToggle={(value) => toggleMulti("priority", value)}
        onClear={() => onChange({ ...filters, priority: [] })}
      />
      )}
      <SearchFilterMenu
        label={t("search.filterBar.updatedLabel")}
        options={options.updated}
        selected={filters.updatedWithin ? [filters.updatedWithin] : []}
        onSelect={(value) => onChange({ ...filters, updatedWithin: value })}
      />
      <div className="ml-auto">
        <SearchSortMenu value={sort} onChange={onSortChange} />
      </div>
    </div>
  );
}
