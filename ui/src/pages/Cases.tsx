import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Layers, SearchX } from "lucide-react";
import { Link } from "@/lib/router";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { relativeTime } from "@/lib/utils";

type StatusFilter = "active" | "all" | CaseStatus;
type GroupBy = "type" | "project" | "status";

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

function CaseListRow({ row }: { row: CaseSummary }) {
  return (
    <Link
      to={`/cases/${row.identifier}`}
      className="grid grid-cols-[7rem_1fr_auto_6rem] items-center gap-3 px-3 py-2 text-sm hover:bg-accent/50"
    >
      <span className="truncate font-mono text-xs text-muted-foreground">{row.identifier}</span>
      <span className="truncate font-medium">{row.title}</span>
      <StatusBadge status={row.status} />
      <span className="text-right text-xs text-muted-foreground tabular-nums">
        {relativeTime(row.updatedAt)}
      </span>
    </Link>
  );
}

function Group({
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
    <div className="overflow-hidden rounded-lg border border-border">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center gap-2 bg-muted/40 px-3 py-2 text-left hover:bg-muted/60"
      >
        {collapsed ? (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        )}
        <span className="text-sm font-semibold">{label}</span>
        <span className="text-xs text-muted-foreground">· {count} {count === 1 ? "case" : "cases"}</span>
      </button>
      {!collapsed && <div className="divide-y divide-border">{children}</div>}
    </div>
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

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>(ALL);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [projectFilter, setProjectFilter] = useState<string>(ALL);
  const [labelFilter, setLabelFilter] = useState<string>(ALL);
  const [groupBy, setGroupBy] = useState<GroupBy>("type");

  useEffect(() => {
    setBreadcrumbs([{ label: "Cases" }]);
  }, [setBreadcrumbs]);

  // Label filtering must happen server-side (labels are not on the list row), so
  // the query is keyed on the label filter; every other filter is client-side.
  const labelId = labelFilter === ALL ? undefined : labelFilter;
  const casesQuery = useQuery({
    queryKey: [...queryKeys.cases.list(selectedCompanyId ?? ""), labelId ?? "all"],
    queryFn: () => casesApi.list(selectedCompanyId!, { labelId, limit: 200 }),
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

  const allCases = useMemo(() => casesQuery.data ?? [], [casesQuery.data]);
  const projectName = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projectsQuery.data ?? []) map.set(p.id, p.name);
    return map;
  }, [projectsQuery.data]);

  const distinctTypes = useMemo(
    () => [...new Set(allCases.map((c) => c.caseType))].sort(),
    [allCases],
  );

  const activeCount = allCases.filter((c) => !TERMINAL_CASE_STATUSES.includes(c.status)).length;
  const terminalCount = allCases.length - activeCount;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allCases.filter((c) => {
      if (statusFilter === "active" && TERMINAL_CASE_STATUSES.includes(c.status)) return false;
      if (statusFilter !== "active" && statusFilter !== "all" && c.status !== statusFilter) return false;
      if (typeFilter !== ALL && c.caseType !== typeFilter) return false;
      if (projectFilter !== ALL && (c.projectId ?? "") !== projectFilter) return false;
      if (q) {
        const haystack = `${c.identifier} ${c.title} ${c.key ?? ""} ${c.summary ?? ""}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [allCases, search, statusFilter, typeFilter, projectFilter]);

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

  if (casesQuery.isLoading) return <PageSkeleton variant="list" />;

  const noCasesAtAll = allCases.length === 0 && labelFilter === ALL;

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
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search cases…"
              className="h-8 w-48"
            />
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger size="sm" className="w-40"><SelectValue placeholder="Type" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All types</SelectItem>
                {distinctTypes.map((t) => (
                  <SelectItem key={t} value={t}>{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
              <SelectTrigger size="sm" className="w-36"><SelectValue placeholder="Status" /></SelectTrigger>
              <SelectContent>
                {STATUS_FILTER_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={projectFilter} onValueChange={setProjectFilter}>
              <SelectTrigger size="sm" className="w-40"><SelectValue placeholder="Project" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All projects</SelectItem>
                {(projectsQuery.data ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={labelFilter} onValueChange={setLabelFilter}>
              <SelectTrigger size="sm" className="w-40"><SelectValue placeholder="Label" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All labels</SelectItem>
                {(labelsQuery.data ?? []).map((l) => (
                  <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="ml-auto flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Group by</span>
              <Select value={groupBy} onValueChange={(v) => setGroupBy(v as GroupBy)}>
                <SelectTrigger size="sm" className="w-32"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="type">Type</SelectItem>
                  <SelectItem value="project">Project</SelectItem>
                  <SelectItem value="status">Status</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <FilterBar filters={activeFilters} onRemove={removeFilter} onClear={clearFilters} />

          {filtered.length === 0 ? (
            <EmptyState icon={SearchX} message="No cases match these filters." action="Clear filters" onAction={clearFilters} />
          ) : (
            <div className="space-y-3">
              {groups.map(([label, rows]) => (
                <Group key={label} label={label} count={rows.length}>
                  {rows.map((row) => (
                    <CaseListRow key={row.id} row={row} />
                  ))}
                </Group>
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
