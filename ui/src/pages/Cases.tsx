import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpDown, Check, ChevronDown, Columns3, Filter, Layers, Search, SearchX } from "lucide-react";
import { Link, useCaseHref } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { casesApi, CASE_STATUSES, TERMINAL_CASE_STATUSES, type CaseStatus, type CaseSummary } from "@/api/cases";
import { projectsApi } from "@/api/projects";
import { issuesApi } from "@/api/issues";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/StatusBadge";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { FilterBar, type FilterValue } from "@/components/FilterBar";
import { IssueGroupHeader } from "@/components/IssueGroupHeader";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { CaseIdentifierKey } from "@/components/CaseIdentifierKey";
import { cn, relativeTime } from "@/lib/utils";

type GroupBy = "type" | "project" | "status";
type CaseColumn = "id" | "title" | "status" | "updated" | "created" | "type" | "project" | "parent";
type CaseSortField = "updated" | "created" | "title" | "status" | "id" | "type" | "project";
type CaseViewState = {
  search: string;
  typeFilters: string[];
  statusFilters: CaseStatus[];
  projectFilters: string[];
  labelFilter: string;
  groupBy: GroupBy;
  sortField: CaseSortField;
  sortDir: "asc" | "desc";
  columns: CaseColumn[];
};

const STATUS_FILTER_OPTIONS: { value: CaseStatus; label: string }[] = [
  { value: "draft", label: "Draft" },
  { value: "in_progress", label: "In progress" },
  { value: "in_review", label: "In review" },
  { value: "approved", label: "Approved" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
];

const ALL = "__all__";
const DEFAULT_STATUS_FILTERS: CaseStatus[] = CASE_STATUSES.filter((status) => !TERMINAL_CASE_STATUSES.includes(status));
const DEFAULT_CASE_COLUMNS: CaseColumn[] = ["id", "title", "status", "updated"];
const CASE_COLUMN_ORDER: CaseColumn[] = ["id", "title", "status", "updated", "created", "type", "project", "parent"];
const CASE_COLUMN_LABELS: Record<CaseColumn, string> = {
  id: "ID / Key",
  title: "Title",
  status: "Status",
  updated: "Updated",
  created: "Created at",
  type: "Type",
  project: "Project",
  parent: "Parent case",
};
const CASE_SORT_LABELS: Record<CaseSortField, string> = {
  updated: "Last updated",
  created: "Created at",
  title: "Title",
  status: "Status",
  id: "ID",
  type: "Type",
  project: "Project",
};
const defaultCaseViewState: CaseViewState = {
  search: "",
  typeFilters: [],
  statusFilters: DEFAULT_STATUS_FILTERS,
  projectFilters: [],
  labelFilter: ALL,
  groupBy: "type",
  sortField: "updated",
  sortDir: "desc",
  columns: DEFAULT_CASE_COLUMNS,
};

function getCaseViewStorageKey(companyId: string | null | undefined): string | null {
  return companyId ? `paperclip:cases:${companyId}:view` : null;
}

function normalizeCaseColumns(value: unknown): CaseColumn[] {
  if (!Array.isArray(value)) return DEFAULT_CASE_COLUMNS;
  const valid = CASE_COLUMN_ORDER.filter((column) => value.includes(column));
  return valid.length > 0 ? valid : DEFAULT_CASE_COLUMNS;
}

function normalizeCaseStatuses(value: unknown): CaseStatus[] {
  if (!Array.isArray(value)) return DEFAULT_STATUS_FILTERS;
  const valid = CASE_STATUSES.filter((status) => value.includes(status));
  return valid.length > 0 ? valid : DEFAULT_STATUS_FILTERS;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizeGroupBy(value: unknown): GroupBy {
  return value === "project" || value === "status" || value === "type" ? value : defaultCaseViewState.groupBy;
}

function normalizeSortField(value: unknown): CaseSortField {
  return value === "created"
    || value === "title"
    || value === "status"
    || value === "id"
    || value === "type"
    || value === "project"
    || value === "updated"
    ? value
    : defaultCaseViewState.sortField;
}

function loadCaseViewState(storageKey: string | null): CaseViewState {
  if (typeof window === "undefined" || !storageKey) return { ...defaultCaseViewState };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) ?? "null");
    if (!parsed || typeof parsed !== "object") return { ...defaultCaseViewState };
    const record = parsed as Record<string, unknown>;
    return {
      search: typeof record.search === "string" ? record.search : defaultCaseViewState.search,
      typeFilters: normalizeStringArray(record.typeFilters),
      statusFilters: normalizeCaseStatuses(record.statusFilters),
      projectFilters: normalizeStringArray(record.projectFilters),
      labelFilter: typeof record.labelFilter === "string" ? record.labelFilter : defaultCaseViewState.labelFilter,
      groupBy: normalizeGroupBy(record.groupBy),
      sortField: normalizeSortField(record.sortField),
      sortDir: record.sortDir === "asc" ? "asc" : "desc",
      columns: normalizeCaseColumns(record.columns),
    };
  } catch {
    return { ...defaultCaseViewState };
  }
}

function saveCaseViewState(storageKey: string | null, state: CaseViewState) {
  if (typeof window === "undefined" || !storageKey) return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    // Ignore localStorage failures; the controls still work for the session.
  }
}

function caseTrailingGridTemplate(columns: CaseColumn[]): string {
  return columns
    .map((column) => {
      if (column === "title") return "minmax(12rem, 1fr)";
      if (column === "id") return "minmax(9rem, 14rem)";
      if (column === "status") return "minmax(6rem, 7rem)";
      if (column === "type") return "minmax(5rem, 8rem)";
      if (column === "project") return "minmax(5rem, 8rem)";
      if (column === "parent") return "minmax(4rem, 6rem)";
      return "minmax(5rem, 6rem)";
    })
    .join(" ");
}

function sameStringSet(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((value) => b.includes(value));
}

function sameStatusSet(a: readonly CaseStatus[], b: readonly CaseStatus[]) {
  return a.length === b.length && a.every((value) => b.includes(value));
}

function CaseStatusPicker({
  status,
  onChange,
  disabled,
}: {
  status: CaseStatus;
  onChange: (next: CaseStatus) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="inline-flex items-center gap-1 rounded-md hover:bg-accent/50 disabled:opacity-50"
          aria-label="Change case status"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <StatusBadge status={status} />
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-44 p-1"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        {STATUS_FILTER_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => {
              setOpen(false);
              if (option.value !== status) onChange(option.value);
            }}
            className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left hover:bg-accent"
          >
            <StatusBadge status={option.value} />
            {option.value === status && <Check className="h-4 w-4 text-muted-foreground" />}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function CaseTrailingColumns({
  row,
  columns,
  projectName,
  onStatusChange,
  statusPending,
}: {
  row: CaseSummary;
  columns: CaseColumn[];
  projectName: string | null;
  onStatusChange: (caseId: string, status: CaseStatus) => void;
  statusPending: boolean;
}) {
  return (
    <span className="grid min-w-0 flex-1 items-center gap-2" style={{ gridTemplateColumns: caseTrailingGridTemplate(columns) }}>
      {columns.map((column) => {
        if (column === "id") {
          return (
            <CaseIdentifierKey
              key={column}
              identifier={row.identifier}
              caseKey={row.key}
              stopPropagation
            />
          );
        }
        if (column === "title") {
          return <span key={column} className="min-w-0 truncate text-sm">{row.title}</span>;
        }
        if (column === "status") {
          return (
            <span key={column} className="min-w-0">
              <CaseStatusPicker
                status={row.status}
                disabled={statusPending}
                onChange={(status) => onStatusChange(row.id, status)}
              />
            </span>
          );
        }
        if (column === "type") {
          return <span key={column} className="min-w-0 truncate text-xs text-muted-foreground">{row.caseType}</span>;
        }
        if (column === "project") {
          return <span key={column} className="min-w-0 truncate text-xs text-muted-foreground">{projectName ?? "No project"}</span>;
        }
        if (column === "parent") {
          return (
            <span key={column} className="min-w-0 truncate font-mono text-xs text-muted-foreground">
              {row.parentCaseId ? "Parent" : "None"}
            </span>
          );
        }
        if (column === "created") {
          return (
            <span key={column} className="text-right text-xs text-muted-foreground tabular-nums">
              {relativeTime(row.createdAt)}
            </span>
          );
        }
        return (
          <span key={column} className="text-right text-xs text-muted-foreground tabular-nums">
            {relativeTime(row.updatedAt)}
          </span>
        );
      })}
    </span>
  );
}

function CaseListRow({
  row,
  projectName,
  visibleColumnSet,
  trailingColumns,
  onStatusChange,
  statusPending,
}: {
  row: CaseSummary;
  projectName: string | null;
  visibleColumnSet: ReadonlySet<CaseColumn>;
  trailingColumns: CaseColumn[];
  onStatusChange: (caseId: string, status: CaseStatus) => void;
  statusPending: boolean;
}) {
  const caseHref = useCaseHref();
  return (
    <Link
      to={caseHref(row.identifier)}
      className="group flex items-start gap-2 border-b border-border py-2.5 pl-2 pr-3 text-sm no-underline text-inherit transition-colors last:border-b-0 hover:bg-accent/50 sm:items-center sm:py-2 sm:pl-1"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-1 sm:contents">
        <span className="line-clamp-2 text-sm sm:hidden">
          {visibleColumnSet.has("title") ? row.title : row.identifier}
        </span>
        <span className="flex items-center gap-2 sm:hidden">
          {visibleColumnSet.has("status") ? (
            <CaseStatusPicker
              status={row.status}
              disabled={statusPending}
              onChange={(status) => onStatusChange(row.id, status)}
            />
          ) : null}
          {visibleColumnSet.has("id") ? (
            <CaseIdentifierKey
              identifier={row.identifier}
              caseKey={row.key}
              className="shrink-0"
              stopPropagation
            />
          ) : null}
          <span className="text-xs text-muted-foreground sm:hidden">{relativeTime(row.updatedAt)}</span>
        </span>
      </span>
      {trailingColumns.length > 0 ? (
        <span className="hidden min-w-0 flex-1 items-center gap-3 sm:order-3 sm:flex">
          <CaseTrailingColumns
            row={row}
            columns={trailingColumns}
            projectName={projectName}
            statusPending={statusPending}
            onStatusChange={onStatusChange}
          />
        </span>
      ) : null}
    </Link>
  );
}

function CaseColumnHeader({
  visibleColumnSet,
  trailingColumns,
}: {
  visibleColumnSet: ReadonlySet<CaseColumn>;
  trailingColumns: CaseColumn[];
}) {
  return (
    <div className="hidden border-b border-border px-2 py-1 text-(length:--text-micro) font-medium uppercase tracking-(--tracking-caps) text-muted-foreground sm:flex sm:items-center">
      {trailingColumns.length > 0 ? (
        <span className="grid min-w-0 flex-1 items-center gap-2" style={{ gridTemplateColumns: caseTrailingGridTemplate(trailingColumns) }}>
          {trailingColumns.map((column) => (
            <span key={column} className={cn("truncate", (column === "updated" || column === "created") && "text-right")}>
              {CASE_COLUMN_LABELS[column]}
            </span>
          ))}
        </span>
      ) : null}
    </div>
  );
}

function CaseGroup({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="mt-6 first:mt-0">
      <IssueGroupHeader
        label={label}
        collapsible
        collapsed={collapsed}
        onToggle={() => setCollapsed((current) => !current)}
        trailing={(
          <span className="text-xs text-muted-foreground tabular-nums">
            {count} {count === 1 ? "case" : "cases"}
          </span>
        )}
      />
      {!collapsed && <div>{children}</div>}
    </div>
  );
}

function CaseToolbarButton({
  icon: Icon,
  title,
  active,
  children,
}: {
  icon: typeof Filter;
  title: string;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className={cn("h-8 w-8 shrink-0", active && "bg-accent")}
          title={title}
          aria-label={title}
        >
          <Icon className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      {children}
    </Popover>
  );
}

function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

function FilterCheckboxRow({
  label,
  checked,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-accent/50">
      <Checkbox
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
        onClick={(event) => event.stopPropagation()}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </label>
  );
}

function CaseColumnPicker({
  visibleColumns,
  onToggle,
  onReset,
}: {
  visibleColumns: ReadonlySet<CaseColumn>;
  onToggle: (column: CaseColumn, enabled: boolean) => void;
  onReset: () => void;
}) {
  return (
    <CaseToolbarButton icon={Columns3} title="Columns" active={!sameStringSet([...visibleColumns], DEFAULT_CASE_COLUMNS)}>
      <PopoverContent align="end" className="w-(--sz-300px) p-1.5">
        <div className="px-2 pb-1 pt-1.5">
          <div className="text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
            Desktop case rows
          </div>
          <div className="text-sm font-medium text-foreground">Choose visible columns</div>
        </div>
        <div className="space-y-0.5">
          {CASE_COLUMN_ORDER.map((column) => (
            <button
              key={column}
              type="button"
              className="flex w-full items-center justify-between rounded px-2 py-1.5 text-sm hover:bg-accent/50"
              onClick={() => onToggle(column, !visibleColumns.has(column))}
            >
              <span>{CASE_COLUMN_LABELS[column]}</span>
              {visibleColumns.has(column) ? <Check className="h-3.5 w-3.5 text-muted-foreground" /> : null}
            </button>
          ))}
        </div>
        <div className="mt-1 border-t border-border pt-1">
          <button
            type="button"
            className="flex w-full items-center justify-between rounded px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent/50"
            onClick={onReset}
          >
            Reset defaults
          </button>
        </div>
      </PopoverContent>
    </CaseToolbarButton>
  );
}

function CaseSortPicker({
  sortField,
  sortDir,
  onChange,
}: {
  sortField: CaseSortField;
  sortDir: "asc" | "desc";
  onChange: (patch: Pick<CaseViewState, "sortField" | "sortDir">) => void;
}) {
  return (
    <CaseToolbarButton icon={ArrowUpDown} title="Sort" active={sortField !== "updated" || sortDir !== "desc"}>
      <PopoverContent align="end" className="w-48 p-2">
        {(Object.keys(CASE_SORT_LABELS) as CaseSortField[]).map((field) => (
          <button
            key={field}
            type="button"
            className={cn(
              "flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm",
              sortField === field ? "bg-accent/50 text-foreground" : "text-muted-foreground hover:bg-accent/50",
            )}
            onClick={() => {
              if (sortField === field) {
                onChange({ sortField, sortDir: sortDir === "asc" ? "desc" : "asc" });
              } else {
                onChange({ sortField: field, sortDir: field === "updated" || field === "created" ? "desc" : "asc" });
              }
            }}
          >
            <span>{CASE_SORT_LABELS[field]}</span>
            {sortField === field ? (
              <span className="text-xs text-muted-foreground">{sortDir === "asc" ? "↑" : "↓"}</span>
            ) : null}
          </button>
        ))}
      </PopoverContent>
    </CaseToolbarButton>
  );
}

/** Full-page onboarding hero shown when the company has zero cases (§6). */
function CasesEmptyHero() {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-4 py-16 text-center">
      <Layers className="h-10 w-10 text-muted-foreground" />
      <h2 className="text-lg font-semibold">No cases yet</h2>
      <p className="text-sm text-muted-foreground">
        Cases are durable work products — blog posts, tweet storms, docs pages — that tasks create and
        iterate on. In v1 they&apos;re created by agents, not from the UI.
      </p>
      <div className="w-full space-y-2 rounded-lg border border-border bg-muted/50 p-4 text-left">
        <p className="text-sm font-medium">To start creating cases, add this to a skill:</p>
        <pre className="overflow-x-auto rounded bg-background/60 p-3 font-mono text-xs text-muted-foreground">
{`"Create a case of type blog_post with fields
{slug, target_audience, publish_url} and key <release>/<slug>."`}
        </pre>
        <p className="text-xs text-muted-foreground">
          See the paperclip skill → <code className="font-mono">references/cases.md</code> for the API.
        </p>
      </div>
      <p className="text-xs text-muted-foreground">
        Feature is gated by the <code className="font-mono">enableCases</code> experimental flag
        (Settings → Experimental).
      </p>
    </div>
  );
}

export function Cases() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  const viewStorageKey = getCaseViewStorageKey(selectedCompanyId);
  const [viewState, setViewState] = useState<CaseViewState>(() => loadCaseViewState(viewStorageKey));

  useEffect(() => {
    setBreadcrumbs([{ label: "Cases" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    setViewState(loadCaseViewState(viewStorageKey));
  }, [viewStorageKey]);

  function updateView(patch: Partial<CaseViewState>) {
    setViewState((current) => {
      const next = { ...current, ...patch };
      saveCaseViewState(viewStorageKey, next);
      return next;
    });
  }

  const usesDefaultStatusFilter = sameStatusSet(viewState.statusFilters, DEFAULT_STATUS_FILTERS);

  const listFilters = useMemo(() => ({
    labelId: viewState.labelFilter === ALL ? undefined : viewState.labelFilter,
    q: viewState.search.trim() || undefined,
    limit: 200,
  }), [viewState.labelFilter, viewState.search]);
  const casesQuery = useQuery({
    queryKey: [...queryKeys.cases.list(selectedCompanyId ?? ""), listFilters],
    queryFn: () => casesApi.list(selectedCompanyId!, listFilters),
    enabled: !!selectedCompanyId,
  });
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId ?? ""),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const labelsQuery = useQuery({
    queryKey: queryKeys.issues.labels(selectedCompanyId ?? ""),
    queryFn: () => issuesApi.listLabels(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const patchCase = useMutation({
    mutationFn: ({ caseId, status }: { caseId: string; status: CaseStatus }) =>
      casesApi.patch(caseId, { status }),
    onSuccess: (updated) => {
      queryClient.setQueryData<CaseSummary[]>(
        [...queryKeys.cases.list(selectedCompanyId ?? ""), listFilters],
        (current) => current?.map((row) => row.id === updated.id ? { ...row, ...updated } : row),
      );
      queryClient.invalidateQueries({ queryKey: queryKeys.cases.list(selectedCompanyId ?? "") });
    },
  });

  const allCases = useMemo(() => casesQuery.data ?? [], [casesQuery.data]);
  const projectName = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projectsQuery.data ?? []) map.set(p.id, p.name);
    return map;
  }, [projectsQuery.data]);

  const distinctTypes = useMemo(
    () => [...new Set([
      ...allCases.map((c) => c.caseType),
      ...viewState.typeFilters,
    ])].sort(),
    [allCases, viewState.typeFilters],
  );

  const filtered = useMemo(() => {
    return allCases.filter((caseRow) => {
      if (viewState.typeFilters.length > 0 && !viewState.typeFilters.includes(caseRow.caseType)) return false;
      if (!viewState.statusFilters.includes(caseRow.status)) return false;
      if (viewState.projectFilters.length > 0) {
        const projectKey = caseRow.projectId ?? ALL;
        if (!viewState.projectFilters.includes(projectKey)) return false;
      }
      return true;
    });
  }, [allCases, viewState.projectFilters, viewState.statusFilters, viewState.typeFilters]);

  const sorted = useMemo(() => {
    const rows = [...filtered];
    rows.sort((a, b) => {
      let result = 0;
      if (viewState.sortField === "updated") result = Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
      else if (viewState.sortField === "created") result = Date.parse(a.createdAt) - Date.parse(b.createdAt);
      else if (viewState.sortField === "title") result = a.title.localeCompare(b.title);
      else if (viewState.sortField === "status") result = a.status.localeCompare(b.status);
      else if (viewState.sortField === "id") result = a.identifier.localeCompare(b.identifier);
      else if (viewState.sortField === "type") result = a.caseType.localeCompare(b.caseType);
      else {
        const aProject = a.projectId ? projectName.get(a.projectId) ?? "" : "";
        const bProject = b.projectId ? projectName.get(b.projectId) ?? "" : "";
        result = aProject.localeCompare(bProject);
      }
      return viewState.sortDir === "desc" ? -result : result;
    });
    return rows;
  }, [filtered, projectName, viewState.sortDir, viewState.sortField]);

  const visibleColumnSet = useMemo(() => new Set(viewState.columns), [viewState.columns]);
  const trailingColumns = useMemo(
    () => CASE_COLUMN_ORDER.filter((column) => visibleColumnSet.has(column)),
    [visibleColumnSet],
  );

  const groups = useMemo(() => {
    const map = new Map<string, CaseSummary[]>();
    for (const c of sorted) {
      let key: string;
      if (viewState.groupBy === "type") key = c.caseType;
      else if (viewState.groupBy === "status") key = c.status;
      else key = c.projectId ? projectName.get(c.projectId) ?? "Unknown project" : "No project";
      const bucket = map.get(key);
      if (bucket) bucket.push(c);
      else map.set(key, [c]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [sorted, viewState.groupBy, projectName]);

  const activeFilters: FilterValue[] = [];
  if (viewState.search.trim()) activeFilters.push({ key: "search", label: "Search", value: viewState.search.trim() });
  if (viewState.typeFilters.length > 0) {
    activeFilters.push({ key: "type", label: "Type", value: viewState.typeFilters.join(", ") });
  }
  if (!usesDefaultStatusFilter) {
    activeFilters.push({
      key: "status",
      label: "Status",
      value: viewState.statusFilters.length === CASE_STATUSES.length
        ? "All"
        : viewState.statusFilters
          .map((status) => STATUS_FILTER_OPTIONS.find((option) => option.value === status)?.label ?? status)
          .join(", "),
    });
  }
  if (viewState.projectFilters.length > 0) {
    activeFilters.push({
      key: "project",
      label: "Project",
      value: viewState.projectFilters
        .map((projectId) => projectId === ALL ? "No project" : projectName.get(projectId) ?? "Project")
        .join(", "),
    });
  }
  if (viewState.labelFilter !== ALL) {
    const name = (labelsQuery.data ?? []).find((l) => l.id === viewState.labelFilter)?.name ?? "Label";
    activeFilters.push({ key: "label", label: "Label", value: name });
  }

  function removeFilter(key: string) {
    if (key === "search") updateView({ search: "" });
    else if (key === "type") updateView({ typeFilters: [] });
    else if (key === "status") updateView({ statusFilters: DEFAULT_STATUS_FILTERS });
    else if (key === "project") updateView({ projectFilters: [] });
    else if (key === "label") updateView({ labelFilter: ALL });
  }
  function clearFilters() {
    updateView({
      search: "",
      typeFilters: [],
      statusFilters: DEFAULT_STATUS_FILTERS,
      projectFilters: [],
      labelFilter: ALL,
    });
  }
  function toggleColumn(column: CaseColumn, enabled: boolean) {
    const next = enabled
      ? [...viewState.columns, column]
      : viewState.columns.filter((value) => value !== column);
    updateView({ columns: normalizeCaseColumns(next) });
  }
  function resetColumns() {
    updateView({ columns: DEFAULT_CASE_COLUMNS });
  }
  function toggleStringFilter(key: "typeFilters" | "projectFilters", value: string, enabled: boolean) {
    const current = viewState[key];
    updateView({
      [key]: enabled
        ? [...current, value]
        : current.filter((item) => item !== value),
    });
  }
  function toggleStatusFilter(status: CaseStatus, enabled: boolean) {
    const next = enabled
      ? [...viewState.statusFilters, status]
      : viewState.statusFilters.filter((item) => item !== status);
    updateView({ statusFilters: normalizeCaseStatuses(next) });
  }

  if (casesQuery.isLoading) return <PageSkeleton variant="list" />;

  const noCasesAtAll = allCases.length === 0 && activeFilters.length === 0;
  const hasActiveFilters = activeFilters.length > 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold">Cases</h1>
          <Badge variant="secondary">Experimental</Badge>
        </div>
      </div>

      {noCasesAtAll ? (
        <CasesEmptyHero />
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 sm:gap-3">
            <div className="relative w-48 sm:w-64 md:w-80">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={viewState.search}
                onChange={(e) => updateView({ search: e.target.value })}
                placeholder="Search cases..."
                className="pl-7 text-xs sm:text-sm"
                aria-label="Search cases"
                data-page-search-target="true"
              />
            </div>

            <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
              <CaseColumnPicker
                visibleColumns={visibleColumnSet}
                onToggle={toggleColumn}
                onReset={resetColumns}
              />

              <CaseToolbarButton icon={Filter} title="Filters" active={hasActiveFilters}>
                <PopoverContent align="end" className="w-72 p-3">
                  <div className="grid gap-3">
                    <FilterField label="Type">
                      <div className="max-h-40 overflow-y-auto">
                        {distinctTypes.length === 0 ? (
                          <p className="px-1 py-1 text-xs text-muted-foreground">No types yet</p>
                        ) : distinctTypes.map((type) => (
                          <FilterCheckboxRow
                            key={type}
                            label={type}
                            checked={viewState.typeFilters.includes(type)}
                            onCheckedChange={(checked) => toggleStringFilter("typeFilters", type, checked)}
                          />
                        ))}
                      </div>
                    </FilterField>
                    <FilterField label="Status">
                      <div>
                        {STATUS_FILTER_OPTIONS.map((option) => (
                          <FilterCheckboxRow
                            key={option.value}
                            label={option.label}
                            checked={viewState.statusFilters.includes(option.value)}
                            onCheckedChange={(checked) => toggleStatusFilter(option.value, checked)}
                          />
                        ))}
                      </div>
                    </FilterField>
                    <FilterField label="Project">
                      <div className="max-h-40 overflow-y-auto">
                        <FilterCheckboxRow
                          label="No project"
                          checked={viewState.projectFilters.includes(ALL)}
                          onCheckedChange={(checked) => toggleStringFilter("projectFilters", ALL, checked)}
                        />
                        {(projectsQuery.data ?? []).map((project) => (
                          <FilterCheckboxRow
                            key={project.id}
                            label={project.name}
                            checked={viewState.projectFilters.includes(project.id)}
                            onCheckedChange={(checked) => toggleStringFilter("projectFilters", project.id, checked)}
                          />
                        ))}
                      </div>
                    </FilterField>
                    <FilterField label="Label">
                      <div className="max-h-40 overflow-y-auto">
                        <FilterCheckboxRow
                          label="All labels"
                          checked={viewState.labelFilter === ALL}
                          onCheckedChange={(checked) => {
                            if (checked) updateView({ labelFilter: ALL });
                          }}
                        />
                        {(labelsQuery.data ?? []).map((label) => (
                          <FilterCheckboxRow
                            key={label.id}
                            label={label.name}
                            checked={viewState.labelFilter === label.id}
                            onCheckedChange={(checked) => updateView({ labelFilter: checked ? label.id : ALL })}
                          />
                        ))}
                      </div>
                    </FilterField>
                    <Button type="button" variant="ghost" size="sm" onClick={clearFilters} disabled={!hasActiveFilters}>
                      Clear filters
                    </Button>
                  </div>
                </PopoverContent>
              </CaseToolbarButton>

              <CaseSortPicker
                sortField={viewState.sortField}
                sortDir={viewState.sortDir}
                onChange={updateView}
              />

              <CaseToolbarButton icon={Layers} title="Group" active={viewState.groupBy !== "type"}>
                <PopoverContent align="end" className="w-44 p-2">
                  {([
                    ["type", "Type"],
                    ["project", "Project"],
                    ["status", "Status"],
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={cn(
                        "flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm",
                        viewState.groupBy === value ? "bg-accent/50 text-foreground" : "text-muted-foreground hover:bg-accent/50",
                      )}
                      onClick={() => updateView({ groupBy: value })}
                    >
                      <span>{label}</span>
                      {viewState.groupBy === value && <Check className="h-3.5 w-3.5" />}
                    </button>
                  ))}
                </PopoverContent>
              </CaseToolbarButton>
            </div>
          </div>

          <FilterBar filters={activeFilters} onRemove={removeFilter} onClear={clearFilters} />

          {filtered.length === 0 ? (
            <EmptyState icon={SearchX} message="No cases match these filters." action="Clear filters" onAction={clearFilters} />
          ) : (
            <div>
              <CaseColumnHeader visibleColumnSet={visibleColumnSet} trailingColumns={trailingColumns} />
              {groups.map(([label, rows]) => (
                <CaseGroup key={label} label={label} count={rows.length}>
                  {rows.map((row) => (
                    <CaseListRow
                      key={row.id}
                      row={row}
                      projectName={row.projectId ? projectName.get(row.projectId) ?? null : null}
                      visibleColumnSet={visibleColumnSet}
                      trailingColumns={trailingColumns}
                      statusPending={patchCase.isPending && patchCase.variables?.caseId === row.id}
                      onStatusChange={(caseId, status) => patchCase.mutate({ caseId, status })}
                    />
                  ))}
                </CaseGroup>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
