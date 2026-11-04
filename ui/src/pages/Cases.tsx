import { useEffect, useLayoutEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { FolderOpen, Search } from "lucide-react";
import { casesApi, CASE_STATUSES, type ListCasesParams } from "@/api/cases";
import { projectsApi } from "@/api/projects";
import { CaseListRow } from "@/components/cases/CaseListRow";
import { CaseListControls } from "@/components/cases/CaseListControls";
import { CollectionToolbar } from "@/components/CollectionToolbar";
import { IssueGroupHeader } from "@/components/IssueGroupHeader";
import { CASE_STATUS_LABELS } from "@/components/cases/CaseStatus";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectPopover } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { useSearchParams } from "@/lib/router";
import { caseListView, DEFAULT_CASE_COLUMNS } from "@/lib/case-list-view";

const PAGE_SIZE = 50;
const ALL = "all";

type FilterOption = { value: string; label: string };

function CaseFilter({ label, value, options, onChange, disabled }: {
  label: string;
  value: string;
  options: FilterOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return <div className="space-y-1">
    <span className="text-xs text-muted-foreground">{label}</span>
    <SelectPopover aria-label={`Filter by ${label.toLowerCase()}`} value={value}
      options={options} onValueChange={onChange} disabled={disabled} className="text-sm data-[size=default]:h-9" />
  </div>;
}

export function Cases() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [params, setParams] = useSearchParams();
  const latestParams = useRef(params);
  useLayoutEffect(() => { latestParams.current = params; }, [params]);
  const query = params.get("q") ?? "";
  const view = caseListView(params);
  const requestedStatus = params.get("status") ?? ALL;
  const status = CASE_STATUSES.includes(requestedStatus as typeof CASE_STATUSES[number]) ? requestedStatus : ALL;
  const type = params.get("type") || ALL;
  const project = params.get("project") || ALL;
  const requestedPage = Number(params.get("page") ?? 1);
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 && requestedPage <= 2_001 ? requestedPage : 1;
  const offset = (page - 1) * PAGE_SIZE;
  const hasFilters = query !== "" || status !== ALL || type !== ALL || project !== ALL;
  const activeFilterCount = [status, type, project].filter(value => value !== ALL).length;
  const filters: ListCasesParams = {
    q: query.trim() || undefined,
    status: status === ALL ? undefined : status,
    type: type === ALL ? undefined : type,
    projectId: project === ALL || project === "none" ? undefined : project,
    includeNoProject: project === "none" || undefined,
    limit: PAGE_SIZE + 1,
    offset,
    ...(view.sortField !== "updated" ? { sortField: view.sortField } : {}),
    ...(view.sortDir !== "desc" ? { sortDir: view.sortDir } : {}),
    ...(view.groupBy !== "none" ? { groupBy: view.groupBy } : {}),
  };

  useEffect(() => setBreadcrumbs([{ label: "Cases" }]), [setBreadcrumbs]);

  const casesQuery = useQuery({
    queryKey: [...queryKeys.cases.list(selectedCompanyId ?? ""), filters],
    queryFn: () => casesApi.list(selectedCompanyId!, filters),
    enabled: !!selectedCompanyId,
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[1] === selectedCompanyId ? previous : undefined,
  });
  const typesQuery = useQuery({
    queryKey: [...queryKeys.cases.list(selectedCompanyId ?? ""), "types"],
    queryFn: () => casesApi.listTypes(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId ?? "", { includeArchived: true }),
    queryFn: () => projectsApi.list(selectedCompanyId!, { includeArchived: true }),
    enabled: !!selectedCompanyId,
  });
  const records = (casesQuery.data ?? []).slice(0, PAGE_SIZE);
  const hasNext = (casesQuery.data?.length ?? 0) > PAGE_SIZE;
  const projectNames = new Map((projectsQuery.data ?? []).map(item => [item.id, item.name]));
  const typeOptions = [...new Set([...(typesQuery.data ?? []), ...(type !== ALL ? [type] : [])])].sort();
  const groups = new Map<string, { label: string; records: typeof records }>();
  for (const record of records) {
    const key = view.groupBy === "status" ? record.status : view.groupBy === "type" ? record.caseType
      : view.groupBy === "project" ? record.projectId ?? "none" : ALL;
    const label = view.groupBy === "status" ? CASE_STATUS_LABELS[record.status]
      : view.groupBy === "project" ? record.projectId ? projectNames.get(record.projectId) ?? "Project unavailable" : "No project" : key;
    if (!groups.has(key)) groups.set(key, { label, records: [] });
    groups.get(key)!.records.push(record);
  }

  const updateParams = (update: (next: URLSearchParams) => void, replace = false) => {
    // Router callbacks each receive the last rendered URL, rather than queued
    // updates. Compose rapid controls against the latest requested URL instead.
    const next = new URLSearchParams(latestParams.current);
    update(next);
    latestParams.current = next;
    setParams(next, { replace });
  };
  const setFilter = (key: string, value: string) => {
    updateParams(next => {
      if (!value || (key !== "q" && value === ALL)) next.delete(key);
      else next.set(key, value);
      next.delete("page");
    }, true);
  };
  const setPage = (nextPage: number) => {
    updateParams(next => {
      if (nextPage === 1) next.delete("page");
      else next.set("page", String(nextPage));
    });
  };
  const setView = (values: Record<string, string>, resetPage = true) => {
    updateParams(next => {
      for (const [key, value] of Object.entries(values)) {
        if (!value) next.delete(key);
        else next.set(key, value);
      }
      if (resetPage) next.delete("page");
    }, true);
  };
  const clearFilters = () => setView({ q: "", status: "", type: "", project: "" });

  if (!selectedCompanyId) return <EmptyState icon={FolderOpen} message="Select a company to view cases." />;

  return (
    <div className="mx-auto max-w-6xl space-y-4" data-testid="case-pages">
      <CollectionToolbar ariaLabel="Case controls" search={<div className="flex min-w-0 items-center gap-3">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search aria-hidden className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Search cases" placeholder="Search cases…" value={query}
            data-page-search-target="true" onChange={event => setFilter("q", event.target.value)} className="h-8 pl-8" />
        </div>
        <p role="status" className="whitespace-nowrap text-xs text-muted-foreground">
          {casesQuery.isFetching ? (casesQuery.isPending ? "Loading cases…" : "Updating cases…")
            : casesQuery.isError ? ""
              : page > 1 && records.length > 0 ? `${offset + 1}–${offset + records.length} cases`
                : `${records.length}${hasNext ? "+" : ""} ${records.length === 1 && !hasNext ? "case" : "cases"}`}
        </p>
      </div>} controls={<CaseListControls activeFilterCount={activeFilterCount} columns={view.columns}
        onColumnsChange={columns => setView({ columns: columns.join(",") === DEFAULT_CASE_COLUMNS.join(",") ? "" : columns.join(",") || "none" }, false)}
        sortField={view.sortField} sortDir={view.sortDir}
        onSortChange={(field, dir) => setView({ sort: field === "updated" ? "" : field, dir: dir === "desc" ? "" : dir })}
        groupBy={view.groupBy} onGroupChange={group => setView({ group: group === "none" ? "" : group })}
        filters={<>
        <CaseFilter label="Status" value={status} onChange={value => setFilter("status", value)} options={[
          { value: ALL, label: "All statuses" },
          ...CASE_STATUSES.map(value => ({ value, label: CASE_STATUS_LABELS[value] })),
        ]} />
        <CaseFilter label="Type" value={type} disabled={typesQuery.isPending || typesQuery.isError}
          onChange={value => setFilter("type", value)} options={[
            { value: ALL, label: "All types" },
            ...typeOptions.map(value => ({ value, label: value })),
          ]} />
        <CaseFilter label="Project" value={project} disabled={projectsQuery.isPending || projectsQuery.isError}
          onChange={value => setFilter("project", value)} options={[
            { value: ALL, label: "All projects" },
            { value: "none", label: "No project" },
            ...(projectsQuery.data ?? []).map(item => ({ value: item.id, label: item.name })),
            ...(project !== ALL && project !== "none" && !projectNames.has(project)
              ? [{ value: project, label: "Selected project" }] : []),
          ]} />
        </>} />}
        feedback={hasFilters ? <Button variant="ghost" size="sm" onClick={clearFilters}>Clear filters</Button> : undefined} />

      {typesQuery.isError || projectsQuery.isError ? <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
        <p>Some case filters couldn’t be loaded.</p>
        <Button variant="ghost" size="sm" onClick={() => {
          if (typesQuery.isError) void typesQuery.refetch();
          if (projectsQuery.isError) void projectsQuery.refetch();
        }}>Retry filters</Button>
      </div> : null}

      {casesQuery.isPending ? <div aria-hidden="true" className="space-y-2">
        {Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-16 w-full rounded-none" />)}
      </div> : casesQuery.isError ? <div role="alert" className="flex flex-wrap items-center gap-3 py-6 text-sm">
        <p>Cases couldn’t be loaded.</p>
        <Button variant="outline" size="sm" onClick={() => void casesQuery.refetch()}>Try again</Button>
      </div> : records.length === 0 ? (
        <EmptyState icon={hasFilters ? Search : FolderOpen}
          message={page > 1 ? "No cases on this page" : hasFilters ? "No cases match these filters" : "No cases yet"}
          action={page > 1 ? "First page" : hasFilters ? "Clear filters" : undefined} hideActionIcon
          onAction={() => page > 1 ? setPage(1) : clearFilters()} />
      ) : <section aria-label="Case list" aria-busy={casesQuery.isFetching} inert={casesQuery.isPlaceholderData} className="border-t border-border">
        {[...groups].map(([key, group]) => <div key={key}>
          {view.groupBy !== "none" && <IssueGroupHeader label={group.label} className="border-b border-border px-3 pt-4" />}
          {group.records.map(record => <CaseListRow key={record.id} caseData={record} columns={view.columns}
            projectName={record.projectId ? projectNames.get(record.projectId) : undefined}
            search={params.size ? `?${params}` : ""} />)}
        </div>)}
      </section>}

      {page > 1 || hasNext ? <nav aria-label="Case list pages" className="flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" disabled={page === 1 || casesQuery.isFetching} onClick={() => setPage(page - 1)}>Previous</Button>
        <Button variant="outline" size="sm" disabled={!hasNext || casesQuery.isFetching} onClick={() => setPage(page + 1)}>Next</Button>
      </nav> : null}
    </div>
  );
}
