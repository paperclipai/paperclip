import { useEffect, useMemo, useRef, useState, startTransition, useDeferredValue } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { ArrowUpDown, Download, FileText, Filter, Layers, X } from "lucide-react";
import type { CompanyDocumentListItem } from "@paperclipai/shared";
import { documentsApi } from "../api/documents";
import { projectsApi } from "../api/projects";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusIcon } from "../components/StatusIcon";
import { issueStatusOrder } from "../lib/issue-filters";
import { issueUrl, relativeTime } from "../lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

const SEARCH_DEBOUNCE_MS = 150;
const ALL_PROJECTS_VALUE = "__all__";
const VIEW_STATE_KEY = "paperclip:documents-view";

type SortField = "updated" | "created" | "title" | "rev";
type SortDir = "asc" | "desc";
type GroupField = "none" | "status" | "project" | "issue" | "origin";

interface DocsViewState {
  sortField: SortField;
  sortDir: SortDir;
  statuses: string[];
  showAutoOrigins: boolean;
  groupBy: GroupField;
}

const defaultViewState: DocsViewState = {
  sortField: "updated",
  sortDir: "desc",
  statuses: [],
  showAutoOrigins: false,
  groupBy: "none",
};

function loadViewState(): DocsViewState {
  if (typeof window === "undefined") return { ...defaultViewState };
  try {
    const raw = window.localStorage.getItem(VIEW_STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        ...defaultViewState,
        ...parsed,
        statuses: Array.isArray(parsed?.statuses) ? parsed.statuses.filter((s: unknown) => typeof s === "string") : [],
      };
    }
  } catch {
    /* ignore */
  }
  return { ...defaultViewState };
}

function saveViewState(state: DocsViewState) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(VIEW_STATE_KEY, JSON.stringify(state));
}

function sortDocuments(docs: CompanyDocumentListItem[], state: DocsViewState): CompanyDocumentListItem[] {
  const sorted = [...docs];
  const dir = state.sortDir === "asc" ? 1 : -1;
  sorted.sort((a, b) => {
    switch (state.sortField) {
      case "updated":
        return dir * (new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
      case "created":
        return dir * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      case "title":
        return dir * (a.title ?? a.key).localeCompare(b.title ?? b.key);
      case "rev":
        return dir * (a.latestRevisionNumber - b.latestRevisionNumber);
      default:
        return 0;
    }
  });
  return sorted;
}

function statusLabel(status: string) {
  return status.replace(/_/g, " ");
}

function originLabel(origin: string) {
  return origin.replace(/_/g, " ");
}

interface DocGroup {
  key: string;
  label: string;
  items: CompanyDocumentListItem[];
}

function groupDocuments(docs: CompanyDocumentListItem[], field: GroupField): DocGroup[] {
  if (field === "none") return [{ key: "__all", label: "", items: docs }];

  const groups = new Map<string, DocGroup>();
  for (const doc of docs) {
    let key: string;
    let label: string;
    switch (field) {
      case "status":
        key = doc.issue.status;
        label = statusLabel(doc.issue.status);
        break;
      case "project":
        key = doc.issue.projectId ?? "__no_project";
        label = doc.issue.project?.name ?? "(No project)";
        break;
      case "issue":
        key = doc.issueId;
        label = `${doc.issue.identifier ?? "—"} ${doc.issue.title}`;
        break;
      case "origin":
        key = doc.issue.originKind;
        label = originLabel(doc.issue.originKind);
        break;
    }
    const existing = groups.get(key);
    if (existing) existing.items.push(doc);
    else groups.set(key, { key, label, items: [doc] });
  }

  const ordered = Array.from(groups.values());
  if (field === "status") {
    ordered.sort((a, b) => issueStatusOrder.indexOf(a.key) - issueStatusOrder.indexOf(b.key));
  } else if (field === "origin") {
    ordered.sort((a, b) => {
      // manual first, then everything else alpha
      if (a.key === "manual") return -1;
      if (b.key === "manual") return 1;
      return a.label.localeCompare(b.label);
    });
  } else {
    ordered.sort((a, b) => a.label.localeCompare(b.label));
  }
  return ordered;
}

export function Documents() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Documents" }]);
  }, [setBreadcrumbs]);

  const [searchDraft, setSearchDraft] = useState("");
  const [committedSearch, setCommittedSearch] = useState("");
  const deferredSearch = useDeferredValue(committedSearch);
  const debounceRef = useRef<number | null>(null);
  const [projectFilter, setProjectFilter] = useState<string>(ALL_PROJECTS_VALUE);
  const [viewState, setViewState] = useState<DocsViewState>(() => loadViewState());

  function updateView(patch: Partial<DocsViewState>) {
    setViewState((current) => {
      const next = { ...current, ...patch };
      saveViewState(next);
      return next;
    });
  }

  function onSearchChange(next: string) {
    setSearchDraft(next);
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
    }
    debounceRef.current = window.setTimeout(() => {
      startTransition(() => setCommittedSearch(next));
    }, SEARCH_DEBOUNCE_MS);
  }

  const filters = useMemo(
    () => ({
      projectId: projectFilter === ALL_PROJECTS_VALUE ? undefined : projectFilter,
      q: deferredSearch.trim() || undefined,
      includeAutoOrigins: viewState.showAutoOrigins || undefined,
    }),
    [projectFilter, deferredSearch, viewState.showAutoOrigins],
  );

  const { data: documents, isLoading, error } = useQuery({
    queryKey: queryKeys.documents.listForCompany(selectedCompanyId!, filters),
    queryFn: () => documentsApi.listForCompany(selectedCompanyId!, filters),
    enabled: !!selectedCompanyId,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentNameById = useMemo(() => {
    const map = new Map<string, string>();
    (agents ?? []).forEach((a) => map.set(a.id, a.name ?? a.id));
    return map;
  }, [agents]);

  const issuePrefix = selectedCompany?.issuePrefix ?? null;

  const visibleDocuments = useMemo(() => {
    const filtered = (documents ?? []).filter((d) =>
      viewState.statuses.length === 0 ? true : viewState.statuses.includes(d.issue.status),
    );
    return sortDocuments(filtered, viewState);
  }, [documents, viewState]);

  const docGroups = useMemo(
    () => groupDocuments(visibleDocuments, viewState.groupBy),
    [visibleDocuments, viewState.groupBy],
  );

  if (!selectedCompanyId) {
    return <EmptyState icon={FileText} message="Select a company to view documents." />;
  }

  const showSkeleton = isLoading && !documents;
  const activeFilterCount = viewState.statuses.length;

  function toggleStatus(status: string) {
    updateView({
      statuses: viewState.statuses.includes(status)
        ? viewState.statuses.filter((s) => s !== status)
        : [...viewState.statuses, status],
    });
  }

  function clickSortField(field: SortField) {
    if (viewState.sortField === field) {
      updateView({ sortDir: viewState.sortDir === "asc" ? "desc" : "asc" });
    } else {
      updateView({ sortField: field, sortDir: field === "title" ? "asc" : "desc" });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={searchDraft}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search documents..."
          data-page-search-target="true"
          className="flex h-9 min-w-0 flex-1 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 sm:max-w-[280px] sm:flex-none"
        />
        <Select value={projectFilter} onValueChange={setProjectFilter}>
          <SelectTrigger className="h-9 w-[160px] sm:w-[200px]">
            <SelectValue placeholder="All projects" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_PROJECTS_VALUE}>All projects</SelectItem>
            {(projects ?? []).map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className={`text-xs ${activeFilterCount > 0 ? "text-blue-600 dark:text-blue-400" : ""}`}
              title={activeFilterCount > 0 ? `Filters: ${activeFilterCount}` : "Filter"}
            >
              <Filter className="h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1" />
              <span className="hidden sm:inline">
                {activeFilterCount > 0 ? `Filters: ${activeFilterCount}` : "Filter"}
              </span>
              {activeFilterCount > 0 && (
                <span className="ml-1 text-[10px] font-medium sm:hidden">{activeFilterCount}</span>
              )}
              {activeFilterCount > 0 && (
                <X
                  className="ml-1 hidden h-3 w-3 sm:block"
                  onClick={(event) => {
                    event.stopPropagation();
                    updateView({ statuses: [] });
                  }}
                />
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-56 p-0">
            <div className="border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Status
            </div>
            <div className="p-2 space-y-0.5">
              {issueStatusOrder.map((status) => {
                const checked = viewState.statuses.includes(status);
                return (
                  <button
                    key={status}
                    type="button"
                    onClick={() => toggleStatus(status)}
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent/50"
                  >
                    <Checkbox checked={checked} className="pointer-events-none" />
                    <span className="capitalize">{statusLabel(status)}</span>
                  </button>
                );
              })}
            </div>
            <div className="border-t border-border px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Source
            </div>
            <div className="p-2 space-y-0.5">
              <button
                type="button"
                onClick={() =>
                  updateView({ showAutoOrigins: !viewState.showAutoOrigins })
                }
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent/50"
              >
                <Checkbox checked={viewState.showAutoOrigins} className="pointer-events-none" />
                <span>Show auto-generated docs</span>
              </button>
            </div>
            {activeFilterCount > 0 && (
              <div className="border-t border-border p-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start text-xs"
                  onClick={() => updateView({ statuses: [] })}
                >
                  <X className="mr-1.5 h-3 w-3" />
                  Clear status filter
                </Button>
              </div>
            )}
          </PopoverContent>
        </Popover>

        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" title="Sort">
              <ArrowUpDown className="h-3.5 w-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-48 p-0">
            <div className="p-2 space-y-0.5">
              {([
                ["updated", "Updated"],
                ["created", "Created"],
                ["title", "Title"],
                ["rev", "Revision"],
              ] as const).map(([field, label]) => (
                <button
                  key={field}
                  type="button"
                  className={`flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm ${
                    viewState.sortField === field
                      ? "bg-accent/50 text-foreground"
                      : "text-muted-foreground hover:bg-accent/50"
                  }`}
                  onClick={() => clickSortField(field)}
                >
                  <span>{label}</span>
                  {viewState.sortField === field && (
                    <span className="text-xs text-muted-foreground">
                      {viewState.sortDir === "asc" ? "↑" : "↓"}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>

        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              className={`h-8 w-8 shrink-0 ${viewState.groupBy !== "none" ? "text-blue-600 dark:text-blue-400" : ""}`}
              title={viewState.groupBy !== "none" ? `Group: ${viewState.groupBy}` : "Group"}
            >
              <Layers className="h-3.5 w-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-44 p-0">
            <div className="p-2 space-y-0.5">
              {([
                ["none", "None"],
                ["status", "Status"],
                ["project", "Project"],
                ["issue", "Issue"],
                ["origin", "Origin"],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm ${
                    viewState.groupBy === value
                      ? "bg-accent/50 text-foreground"
                      : "text-muted-foreground hover:bg-accent/50"
                  }`}
                  onClick={() => updateView({ groupBy: value })}
                >
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>

        {documents && (
          <span className="ml-auto text-xs text-muted-foreground">
            {visibleDocuments.length} {visibleDocuments.length === 1 ? "document" : "documents"}
          </span>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {showSkeleton && <PageSkeleton variant="list" />}

      {!showSkeleton && documents && visibleDocuments.length === 0 && (
        <EmptyState
          icon={FileText}
          message={
            committedSearch || projectFilter !== ALL_PROJECTS_VALUE || activeFilterCount > 0
              ? "No documents match the current filters."
              : !viewState.showAutoOrigins
                ? "No documents from manual issues. Auto-generated docs (routines, productivity reviews, recovery) are hidden — use the filter to include them."
                : "No documents yet. Documents created on issues will show up here."
          }
        />
      )}

      {!showSkeleton && documents && visibleDocuments.length > 0 && (
        <>
          {/* Mobile: stacked cards. Tap title to view; download icon trailing right. */}
          <div className="sm:hidden">
            {docGroups.map((group) => (
              <div key={group.key} className="mb-4 last:mb-0">
                {viewState.groupBy !== "none" && (
                  <h3 className="mb-2 flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    <span className="capitalize">{group.label}</span>
                    <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] tabular-nums">
                      {group.items.length}
                    </span>
                  </h3>
                )}
                <ul className="space-y-2">
                  {group.items.map((doc) => {
                    const issueHref = issuePrefix
                      ? `/${issuePrefix}/issues/${doc.issue.identifier ?? doc.issue.id}`
                      : issueUrl({ id: doc.issue.id, identifier: doc.issue.identifier });
                    const docHref = issuePrefix
                      ? `/${issuePrefix}/documents/${doc.issueId}/${encodeURIComponent(doc.key)}`
                      : `/documents/${doc.issueId}/${encodeURIComponent(doc.key)}`;
                    const downloadHref = `/api/issues/${doc.issueId}/documents/${encodeURIComponent(doc.key)}/download`;
                    const author =
                      (doc.updatedByAgentId && agentNameById.get(doc.updatedByAgentId)) ||
                      (doc.createdByAgentId && agentNameById.get(doc.createdByAgentId)) ||
                      (doc.updatedByUserId ? "user" : null);
                    return (
                      <li key={doc.id} className="rounded-md border border-border p-3">
                  <div className="flex items-start gap-2">
                    <Link to={docHref} className="min-w-0 flex-1 text-foreground hover:underline">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="shrink-0 rounded-full border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                          {doc.key}
                        </span>
                        <span className="break-words font-medium">
                          {doc.issue.identifier ? (
                            <span className="text-muted-foreground">{doc.issue.identifier} - </span>
                          ) : null}
                          {doc.title ?? doc.key}
                        </span>
                      </div>
                    </Link>
                    <a
                      href={downloadHref}
                      download={`${doc.key}.md`}
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                      title="Download document"
                      aria-label="Download document"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Download className="h-4 w-4" />
                    </a>
                  </div>
                  <div className="mt-2 flex items-center gap-1.5">
                    <span onClick={(e) => { e.preventDefault(); e.stopPropagation(); }} className="shrink-0">
                      <StatusIcon status={doc.issue.status} />
                    </span>
                    <Link to={issueHref} className="min-w-0 truncate text-xs text-muted-foreground hover:text-foreground hover:underline">
                      {doc.issue.identifier ?? "—"}
                      {doc.issue.title ? <span className="ml-1 text-muted-foreground">{doc.issue.title}</span> : null}
                    </Link>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                    {doc.issue.project?.name && <span>{doc.issue.project.name}</span>}
                    {author && <span>· {author}</span>}
                    <span>· rev {doc.latestRevisionNumber}</span>
                    <span title={new Date(doc.updatedAt).toLocaleString()}>
                      · updated {relativeTime(doc.updatedAt)}
                    </span>
                  </div>
                </li>
              );
            })}
                </ul>
              </div>
            ))}
          </div>

          {/* Desktop / tablet: table. */}
          <div className="hidden overflow-hidden rounded-md border border-border sm:block">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Document</th>
                  <th className="px-3 py-2 font-medium">Issue</th>
                  <th className="px-3 py-2 font-medium">Project</th>
                  <th className="px-3 py-2 font-medium">Author</th>
                  <th className="px-3 py-2 font-medium text-right">Rev</th>
                  <th className="px-3 py-2 font-medium text-right">Updated</th>
                  <th className="w-10 px-2 py-2"></th>
                </tr>
              </thead>
              {docGroups.map((group) => (
              <tbody key={group.key}>
                {viewState.groupBy !== "none" && (
                  <tr className="bg-muted/20">
                    <td colSpan={7} className="px-3 py-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      <span className="capitalize">{group.label}</span>
                      <span className="ml-2 rounded-full border border-border px-1.5 py-0.5 text-[10px] tabular-nums">
                        {group.items.length}
                      </span>
                    </td>
                  </tr>
                )}
                {group.items.map((doc) => {
                  const issueHref = issuePrefix
                    ? `/${issuePrefix}/issues/${doc.issue.identifier ?? doc.issue.id}`
                    : issueUrl({ id: doc.issue.id, identifier: doc.issue.identifier });
                  const docHref = issuePrefix
                    ? `/${issuePrefix}/documents/${doc.issueId}/${encodeURIComponent(doc.key)}`
                    : `/documents/${doc.issueId}/${encodeURIComponent(doc.key)}`;
                  const downloadHref = `/api/issues/${doc.issueId}/documents/${encodeURIComponent(doc.key)}/download`;
                  const author =
                    (doc.updatedByAgentId && agentNameById.get(doc.updatedByAgentId)) ||
                    (doc.createdByAgentId && agentNameById.get(doc.createdByAgentId)) ||
                    (doc.updatedByUserId ? "user" : null);
                  return (
                    <tr key={doc.id} className="border-b border-border last:border-0 hover:bg-accent/30">
                      <td className="px-3 py-2 align-top">
                        <Link to={docHref} className="block text-foreground hover:underline">
                          <div className="flex items-center gap-2">
                            <span className="shrink-0 rounded-full border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                              {doc.key}
                            </span>
                            <span className="font-medium">
                              {doc.issue.identifier ? (
                                <span className="text-muted-foreground">{doc.issue.identifier} - </span>
                              ) : null}
                              {doc.title ?? doc.key}
                            </span>
                          </div>
                        </Link>
                      </td>
                      <td className="px-3 py-2 align-top text-muted-foreground">
                        <div className="flex items-center gap-1.5">
                          <span onClick={(e) => { e.preventDefault(); e.stopPropagation(); }} className="shrink-0">
                            <StatusIcon status={doc.issue.status} />
                          </span>
                          <Link to={issueHref} className="min-w-0 hover:text-foreground hover:underline">
                            {doc.issue.identifier ?? "—"}{" "}
                            <span className="text-xs">{doc.issue.title}</span>
                          </Link>
                        </div>
                      </td>
                      <td className="px-3 py-2 align-top text-muted-foreground">
                        {doc.issue.project?.name ?? "—"}
                      </td>
                      <td className="px-3 py-2 align-top text-muted-foreground">{author ?? "—"}</td>
                      <td className="px-3 py-2 align-top text-right tabular-nums text-muted-foreground">
                        {doc.latestRevisionNumber}
                      </td>
                      <td
                        className="px-3 py-2 align-top text-right text-muted-foreground"
                        title={new Date(doc.updatedAt).toLocaleString()}
                      >
                        {relativeTime(doc.updatedAt)}
                      </td>
                      <td className="px-2 py-2 text-right align-top">
                        <a
                          href={downloadHref}
                          download={`${doc.key}.md`}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                          title="Download document"
                          aria-label="Download document"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Download className="h-3.5 w-3.5" />
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              ))}
            </table>
          </div>
        </>
      )}
    </div>
  );
}
