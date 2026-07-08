import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Columns3, Filter, Layers, Search, SearchX } from "lucide-react";
import { Link, useCaseHref } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { casesApi, TERMINAL_CASE_STATUSES, type CaseStatus, type CaseSummary } from "@/api/cases";
import { projectsApi } from "@/api/projects";
import { issuesApi } from "@/api/issues";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/StatusBadge";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { FilterBar, type FilterValue } from "@/components/FilterBar";
import { IssueGroupHeader } from "@/components/IssueGroupHeader";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { cn, relativeTime } from "@/lib/utils";

type StatusFilter = "active" | "all" | CaseStatus;
type GroupBy = "type" | "project" | "status";
type CaseColumn = "status" | "id" | "type" | "project" | "parent" | "updated";

const STATUS_FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "all", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "in_progress", label: "In progress" },
  { value: "in_review", label: "In review" },
  { value: "approved", label: "Approved" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
];

const ALL = "__all__";
const CASE_COLUMNS_STORAGE_KEY = "paperclip:cases:columns";
const DEFAULT_CASE_COLUMNS: CaseColumn[] = ["status", "id", "type", "project", "updated"];
const CASE_TRAILING_COLUMNS: CaseColumn[] = ["type", "project", "parent", "updated"];
const CASE_COLUMN_LABELS: Record<CaseColumn, string> = {
  status: "Status",
  id: "ID",
  type: "Type",
  project: "Project",
  parent: "Parent case",
  updated: "Last updated",
};

function loadCaseColumns(): CaseColumn[] {
  if (typeof window === "undefined") return DEFAULT_CASE_COLUMNS;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CASE_COLUMNS_STORAGE_KEY) ?? "null");
    if (!Array.isArray(parsed)) return DEFAULT_CASE_COLUMNS;
    const valid = parsed.filter((value): value is CaseColumn => (
      value === "status"
      || value === "id"
      || value === "type"
      || value === "project"
      || value === "parent"
      || value === "updated"
    ));
    return valid.length > 0 ? valid : DEFAULT_CASE_COLUMNS;
  } catch {
    return DEFAULT_CASE_COLUMNS;
  }
}

function saveCaseColumns(columns: CaseColumn[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(CASE_COLUMNS_STORAGE_KEY, JSON.stringify(columns));
}

function caseTrailingGridTemplate(columns: CaseColumn[]): string {
  return columns
    .map((column) => {
      if (column === "type") return "minmax(5rem, 8rem)";
      if (column === "project") return "minmax(5rem, 8rem)";
      if (column === "parent") return "minmax(4rem, 6rem)";
      return "minmax(4rem, 5rem)";
    })
    .join(" ");
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
        {STATUS_FILTER_OPTIONS.filter((option): option is { value: CaseStatus; label: string } =>
          option.value !== "active" && option.value !== "all",
        ).map((option) => (
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
}: {
  row: CaseSummary;
  columns: CaseColumn[];
  projectName: string | null;
}) {
  return (
    <span className="grid items-center gap-2" style={{ gridTemplateColumns: caseTrailingGridTemplate(columns) }}>
      {columns.map((column) => {
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
        <span className="line-clamp-2 text-sm sm:order-2 sm:min-w-0 sm:flex-1 sm:truncate sm:line-clamp-none">
          {row.title}
        </span>
        <span className="flex items-center gap-2 sm:order-1 sm:shrink-0">
          {visibleColumnSet.has("status") ? (
            <CaseStatusPicker
              status={row.status}
              disabled={statusPending}
              onChange={(status) => onStatusChange(row.id, status)}
            />
          ) : null}
          {visibleColumnSet.has("id") ? (
            <span className="shrink-0 font-mono text-xs text-muted-foreground">{row.identifier}</span>
          ) : null}
          <span className="text-xs text-muted-foreground sm:hidden">{relativeTime(row.updatedAt)}</span>
        </span>
      </span>
      {trailingColumns.length > 0 ? (
        <span className="ml-auto hidden shrink-0 items-center gap-3 sm:order-3 sm:flex">
          <CaseTrailingColumns row={row} columns={trailingColumns} projectName={projectName} />
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
      <span className="flex min-w-0 flex-1 items-center gap-2">
        {visibleColumnSet.has("status") ? <span className="w-16 shrink-0">{CASE_COLUMN_LABELS.status}</span> : null}
        {visibleColumnSet.has("id") ? <span className="w-16 shrink-0">{CASE_COLUMN_LABELS.id}</span> : null}
        <span className="min-w-0 flex-1 truncate">Title</span>
      </span>
      {trailingColumns.length > 0 ? (
        <span className="ml-auto grid shrink-0 items-center gap-2" style={{ gridTemplateColumns: caseTrailingGridTemplate(trailingColumns) }}>
          {trailingColumns.map((column) => (
            <span key={column} className={cn("truncate", column === "updated" && "text-right")}>
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
    <div>
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
    <label className="grid gap-1 text-xs font-medium text-muted-foreground">
      {label}
      {children}
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
    <CaseToolbarButton icon={Columns3} title="Columns" active={visibleColumns.size !== DEFAULT_CASE_COLUMNS.length}>
      <PopoverContent align="end" className="w-(--sz-300px) p-1.5">
        <div className="px-2 pb-1 pt-1.5">
          <div className="text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
            Desktop case rows
          </div>
          <div className="text-sm font-medium text-foreground">Choose visible columns</div>
        </div>
        <div className="space-y-0.5">
          {(Object.keys(CASE_COLUMN_LABELS) as CaseColumn[]).map((column) => (
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

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>(ALL);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [projectFilter, setProjectFilter] = useState<string>(ALL);
  const [labelFilter, setLabelFilter] = useState<string>(ALL);
  const [groupBy, setGroupBy] = useState<GroupBy>("project");
  const [visibleColumns, setVisibleColumns] = useState<CaseColumn[]>(loadCaseColumns);

  useEffect(() => {
    setBreadcrumbs([{ label: "Cases" }]);
  }, [setBreadcrumbs]);

  const listFilters = useMemo(() => ({
    labelId: labelFilter === ALL ? undefined : labelFilter,
    type: typeFilter === ALL ? undefined : typeFilter,
    status: statusFilter === "all" ? undefined : statusFilter,
    projectId: projectFilter === ALL ? undefined : projectFilter,
    q: search.trim() || undefined,
    limit: 200,
  }), [labelFilter, projectFilter, search, statusFilter, typeFilter]);
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
      ...(typeFilter === ALL ? [] : [typeFilter]),
    ])].sort(),
    [allCases, typeFilter],
  );

  const activeCount = allCases.filter((c) => !TERMINAL_CASE_STATUSES.includes(c.status)).length;
  const terminalCount = allCases.length - activeCount;

  const filtered = allCases;
  const visibleColumnSet = useMemo(() => new Set(visibleColumns), [visibleColumns]);
  const trailingColumns = useMemo(
    () => CASE_TRAILING_COLUMNS.filter((column) => visibleColumnSet.has(column)),
    [visibleColumnSet],
  );

  const groups = useMemo(() => {
    const map = new Map<string, CaseSummary[]>();
    for (const c of filtered) {
      let key: string;
      if (groupBy === "type") key = c.caseType;
      else if (groupBy === "status") key = c.status;
      else key = c.projectId ? projectName.get(c.projectId) ?? "Unknown project" : "No project";
      const bucket = map.get(key);
      if (bucket) bucket.push(c);
      else map.set(key, [c]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered, groupBy, projectName]);

  const activeFilters: FilterValue[] = [];
  if (search.trim()) activeFilters.push({ key: "search", label: "Search", value: search.trim() });
  if (typeFilter !== ALL) activeFilters.push({ key: "type", label: "Type", value: typeFilter });
  if (statusFilter !== "active") {
    activeFilters.push({
      key: "status",
      label: "Status",
      value: STATUS_FILTER_OPTIONS.find((o) => o.value === statusFilter)?.label ?? statusFilter,
    });
  }
  if (projectFilter !== ALL) {
    activeFilters.push({ key: "project", label: "Project", value: projectName.get(projectFilter) ?? "Project" });
  }
  if (labelFilter !== ALL) {
    const name = (labelsQuery.data ?? []).find((l) => l.id === labelFilter)?.name ?? "Label";
    activeFilters.push({ key: "label", label: "Label", value: name });
  }

  function removeFilter(key: string) {
    if (key === "search") setSearch("");
    else if (key === "type") setTypeFilter(ALL);
    else if (key === "status") setStatusFilter("active");
    else if (key === "project") setProjectFilter(ALL);
    else if (key === "label") setLabelFilter(ALL);
  }
  function clearFilters() {
    setSearch("");
    setTypeFilter(ALL);
    setStatusFilter("active");
    setProjectFilter(ALL);
    setLabelFilter(ALL);
  }
  function toggleColumn(column: CaseColumn, enabled: boolean) {
    const next = enabled
      ? [...visibleColumns, column]
      : visibleColumns.filter((value) => value !== column);
    const normalized = (Object.keys(CASE_COLUMN_LABELS) as CaseColumn[]).filter((value) => next.includes(value));
    setVisibleColumns(normalized);
    saveCaseColumns(normalized);
  }
  function resetColumns() {
    setVisibleColumns(DEFAULT_CASE_COLUMNS);
    saveCaseColumns(DEFAULT_CASE_COLUMNS);
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
        <span className="text-xs text-muted-foreground tabular-nums">
          {activeCount} active · {allCases.length} total
        </span>
      </div>

      {noCasesAtAll ? (
        <CasesEmptyHero />
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 sm:gap-3">
            <div className="relative w-48 sm:w-64 md:w-80">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
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
                <PopoverContent align="end" className="w-64 p-3">
                  <div className="grid gap-3">
                    <FilterField label="Type">
                      <Select value={typeFilter} onValueChange={setTypeFilter}>
                        <SelectTrigger size="sm"><SelectValue placeholder="Type" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value={ALL}>All types</SelectItem>
                          {distinctTypes.map((t) => (
                            <SelectItem key={t} value={t}>{t}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FilterField>
                    <FilterField label="Status">
                      <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
                        <SelectTrigger size="sm"><SelectValue placeholder="Status" /></SelectTrigger>
                        <SelectContent>
                          {STATUS_FILTER_OPTIONS.map((o) => (
                            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FilterField>
                    <FilterField label="Project">
                      <Select value={projectFilter} onValueChange={setProjectFilter}>
                        <SelectTrigger size="sm"><SelectValue placeholder="Project" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value={ALL}>All projects</SelectItem>
                          {(projectsQuery.data ?? []).map((p) => (
                            <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FilterField>
                    <FilterField label="Label">
                      <Select value={labelFilter} onValueChange={setLabelFilter}>
                        <SelectTrigger size="sm"><SelectValue placeholder="Label" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value={ALL}>All labels</SelectItem>
                          {(labelsQuery.data ?? []).map((l) => (
                            <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FilterField>
                    <Button type="button" variant="ghost" size="sm" onClick={clearFilters} disabled={!hasActiveFilters}>
                      Clear filters
                    </Button>
                  </div>
                </PopoverContent>
              </CaseToolbarButton>

              <CaseToolbarButton icon={Layers} title="Group" active={groupBy !== "project"}>
                <PopoverContent align="end" className="w-44 p-2">
                  {([
                    ["project", "Project"],
                    ["type", "Type"],
                    ["status", "Status"],
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={cn(
                        "flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm",
                        groupBy === value ? "bg-accent/50 text-foreground" : "text-muted-foreground hover:bg-accent/50",
                      )}
                      onClick={() => setGroupBy(value)}
                    >
                      <span>{label}</span>
                      {groupBy === value && <Check className="h-3.5 w-3.5" />}
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

          {statusFilter === "active" && terminalCount > 0 && (
            <p className="text-xs text-muted-foreground">
              {terminalCount} done/cancelled {terminalCount === 1 ? "case" : "cases"} hidden by Status: Active —
              switch the filter to see them.
            </p>
          )}
        </>
      )}
    </div>
  );
}
