import { useEffect, useMemo, useRef, useState, startTransition, useDeferredValue, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { ArrowUpDown, ChevronDown, ChevronRight, Download, FileText, Filter, Layers, ListTree, X } from "lucide-react";
import type { CompanyDocumentListItem } from "@paperclipai/shared";
import { documentsApi } from "../api/documents";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusIcon } from "../components/StatusIcon";
import { issueStatusOrder } from "../lib/issue-filters";
import { issueUrl, relativeTime, cn } from "../lib/utils";
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
  showRoutineExecutions: boolean;
  groupBy: GroupField;
  collapsedGroups: string[];
  nestingEnabled: boolean;
  collapsedParents: string[];
}

const defaultViewState: DocsViewState = {
  sortField: "updated",
  sortDir: "desc",
  statuses: [],
  showRoutineExecutions: false,
  groupBy: "none",
  collapsedGroups: [],
  nestingEnabled: true,
  collapsedParents: [],
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
        statuses: Array.isArray(parsed?.statuses)
          ? parsed.statuses.filter((s: unknown) => typeof s === "string")
          : [],
        collapsedGroups: Array.isArray(parsed?.collapsedGroups)
          ? parsed.collapsedGroups.filter((s: unknown) => typeof s === "string")
          : [],
        nestingEnabled:
          typeof parsed?.nestingEnabled === "boolean"
            ? parsed.nestingEnabled
            : defaultViewState.nestingEnabled,
        collapsedParents: Array.isArray(parsed?.collapsedParents)
          ? parsed.collapsedParents.filter((s: unknown) => typeof s === "string")
          : [],
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
      includeRoutineExecutions: viewState.showRoutineExecutions || undefined,
    }),
    [projectFilter, deferredSearch, viewState.showRoutineExecutions],
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

  const queryClient = useQueryClient();

  const updateIssueStatus = useMutation({
    mutationFn: ({ issueId, status }: { issueId: string; status: string }) =>
      issuesApi.update(issueId, { status }),
    onSuccess: () => {
      if (!selectedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: ["documents", selectedCompanyId] });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId) });
    },
  });

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

  function toggleGroup(key: string) {
    updateView({
      collapsedGroups: viewState.collapsedGroups.includes(key)
        ? viewState.collapsedGroups.filter((k) => k !== key)
        : [...viewState.collapsedGroups, key],
    });
  }

  function toggleParent(issueId: string) {
    updateView({
      collapsedParents: viewState.collapsedParents.includes(issueId)
        ? viewState.collapsedParents.filter((id) => id !== issueId)
        : [...viewState.collapsedParents, issueId],
    });
  }

  function renderNestedRows(items: CompanyDocumentListItem[]) {
    const byIssue = new Map<string, CompanyDocumentListItem[]>();
    for (const doc of items) {
      const arr = byIssue.get(doc.issueId) ?? [];
      arr.push(doc);
      byIssue.set(doc.issueId, arr);
    }
    const nodes: ReactNode[] = [];
    for (const [issueId, docs] of byIssue) {
      if (docs.length === 1) {
        const doc = docs[0];
        nodes.push(
          <DocumentRow
            key={doc.id}
            doc={doc}
            issuePrefix={issuePrefix}
            agentNameById={agentNameById}
            onChangeStatus={(status) =>
              updateIssueStatus.mutate({ issueId: doc.issue.id, status })
            }
          />,
        );
      } else {
        const issue = docs[0].issue;
        const expanded = !viewState.collapsedParents.includes(issueId);
        nodes.push(
          <IssueParentRow
            key={`parent-${issueId}`}
            issue={issue}
            docCount={docs.length}
            issuePrefix={issuePrefix}
            expanded={expanded}
            onToggleExpanded={() => toggleParent(issueId)}
            onChangeStatus={(status) =>
              updateIssueStatus.mutate({ issueId, status })
            }
          />,
        );
        if (expanded) {
          for (const doc of docs) {
            nodes.push(
              <DocumentRow
                key={doc.id}
                doc={doc}
                issuePrefix={issuePrefix}
                agentNameById={agentNameById}
                onChangeStatus={(status) =>
                  updateIssueStatus.mutate({ issueId: doc.issue.id, status })
                }
                depth={1}
              />,
            );
          }
        }
      }
    }
    return nodes;
  }

  function clickSortField(field: SortField) {
    if (viewState.sortField === field) {
      updateView({ sortDir: viewState.sortDir === "asc" ? "desc" : "asc" });
    } else {
      updateView({ sortField: field, sortDir: field === "title" ? "asc" : "desc" });
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={searchDraft}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search documents..."
          data-page-search-target="true"
          className="flex h-9 min-w-0 flex-1 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:max-w-[280px] sm:flex-none"
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
              size="icon"
              className={cn(
                "relative h-8 w-8 shrink-0",
                activeFilterCount > 0 && "text-blue-600 dark:text-blue-400",
              )}
              title={activeFilterCount > 0 ? `Filters: ${activeFilterCount}` : "Filter"}
            >
              <Filter className="h-3.5 w-3.5" />
              {activeFilterCount > 0 && (
                <span className="absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-blue-600 text-[9px] font-bold text-white">
                  {activeFilterCount}
                </span>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-56 p-0">
            <div className="border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Status
            </div>
            <div className="space-y-0.5 p-2">
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
            <div className="space-y-0.5 p-2">
              <button
                type="button"
                onClick={() =>
                  updateView({ showRoutineExecutions: !viewState.showRoutineExecutions })
                }
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent/50"
              >
                <Checkbox checked={viewState.showRoutineExecutions} className="pointer-events-none" />
                <span>Show routine docs</span>
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
            <div className="space-y-0.5 p-2">
              {([
                ["updated", "Updated"],
                ["created", "Created"],
                ["title", "Title"],
                ["rev", "Revision"],
              ] as const).map(([field, label]) => (
                <button
                  key={field}
                  type="button"
                  className={cn(
                    "flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm",
                    viewState.sortField === field
                      ? "bg-accent/50 text-foreground"
                      : "text-muted-foreground hover:bg-accent/50",
                  )}
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
              className={cn(
                "h-8 w-8 shrink-0",
                viewState.groupBy !== "none" && "text-blue-600 dark:text-blue-400",
              )}
              title={viewState.groupBy !== "none" ? `Group: ${viewState.groupBy}` : "Group"}
            >
              <Layers className="h-3.5 w-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-44 p-0">
            <div className="space-y-0.5 p-2">
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
                  className={cn(
                    "flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm",
                    viewState.groupBy === value
                      ? "bg-accent/50 text-foreground"
                      : "text-muted-foreground hover:bg-accent/50",
                  )}
                  onClick={() => updateView({ groupBy: value })}
                >
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>

        <Button
          type="button"
          variant="outline"
          size="icon"
          className={cn(
            "h-8 w-8 shrink-0",
            viewState.nestingEnabled && "bg-accent text-blue-600 dark:text-blue-400",
          )}
          onClick={() => updateView({ nestingEnabled: !viewState.nestingEnabled })}
          title={
            viewState.nestingEnabled
              ? "Disable parent-child nesting"
              : "Enable parent-child nesting"
          }
        >
          <ListTree className="h-3.5 w-3.5" />
        </Button>

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
              : !viewState.showRoutineExecutions
                ? "No documents. Routine-spawned docs are hidden — use the filter to include them."
                : "No documents yet. Documents created on issues will show up here."
          }
        />
      )}

      {!showSkeleton && documents && visibleDocuments.length > 0 && (
        <div className="space-y-3">
          {docGroups.map((group) => {
            const isCollapsed = viewState.collapsedGroups.includes(group.key);
            return (
              <div key={group.key}>
                {viewState.groupBy !== "none" && (
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.key)}
                    className="flex w-full items-center gap-2 px-2 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground"
                  >
                    {isCollapsed ? (
                      <ChevronRight className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronDown className="h-3.5 w-3.5" />
                    )}
                    <span className="capitalize">{group.label}</span>
                    <span className="text-[11px] tabular-nums text-muted-foreground/70">
                      {group.items.length}
                    </span>
                  </button>
                )}
                {!isCollapsed && (
                  <ul>
                    {viewState.nestingEnabled && viewState.groupBy !== "issue"
                      ? renderNestedRows(group.items)
                      : group.items.map((doc) => (
                          <DocumentRow
                            key={doc.id}
                            doc={doc}
                            issuePrefix={issuePrefix}
                            agentNameById={agentNameById}
                            onChangeStatus={(status) =>
                              updateIssueStatus.mutate({ issueId: doc.issue.id, status })
                            }
                          />
                        ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface DocumentRowProps {
  doc: CompanyDocumentListItem;
  issuePrefix: string | null;
  agentNameById: Map<string, string>;
  onChangeStatus: (status: string) => void;
  depth?: number;
}

function DocumentRow({ doc, issuePrefix, agentNameById, onChangeStatus, depth = 0 }: DocumentRowProps) {
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
  const displayTitle = doc.title?.trim() || doc.key;
  const isNested = depth > 0;

  return (
    <li
      className="group flex items-center gap-2 border-b border-border py-2 pr-2 text-sm last:border-b-0 hover:bg-accent/40"
      style={{ paddingLeft: `${depth * 16 + 8}px` }}
    >
      {!isNested && <StatusIcon status={doc.issue.status} onChange={onChangeStatus} />}
      {!isNested && (
        <Link
          to={issueHref}
          className="shrink-0 font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
          title={doc.issue.title}
        >
          {doc.issue.identifier ?? "—"}
        </Link>
      )}
      <Link
        to={docHref}
        className="inline-flex min-w-0 flex-1 items-center gap-1.5 text-foreground no-underline hover:underline"
        title={`${displayTitle} (key: ${doc.key})`}
      >
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{displayTitle}</span>
      </Link>
      <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
        {doc.issue.project?.name ?? ""}
      </span>
      {author && (
        <span className="hidden shrink-0 text-xs text-muted-foreground md:inline">{author}</span>
      )}
      <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground md:inline">
        rev {doc.latestRevisionNumber}
      </span>
      <span
        className="shrink-0 text-xs text-muted-foreground"
        title={new Date(doc.updatedAt).toLocaleString()}
      >
        {relativeTime(doc.updatedAt)}
      </span>
      <a
        href={downloadHref}
        download={`${doc.key}.md`}
        onClick={(e) => e.stopPropagation()}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent/50 hover:text-foreground group-hover:opacity-100 focus:opacity-100"
        title="Download document"
        aria-label="Download document"
      >
        <Download className="h-3.5 w-3.5" />
      </a>
    </li>
  );
}

interface IssueParentRowProps {
  issue: CompanyDocumentListItem["issue"];
  docCount: number;
  issuePrefix: string | null;
  expanded: boolean;
  onToggleExpanded: () => void;
  onChangeStatus: (status: string) => void;
}

function IssueParentRow({
  issue,
  docCount,
  issuePrefix,
  expanded,
  onToggleExpanded,
  onChangeStatus,
}: IssueParentRowProps) {
  const issueHref = issuePrefix
    ? `/${issuePrefix}/issues/${issue.identifier ?? issue.id}`
    : issueUrl({ id: issue.id, identifier: issue.identifier });

  return (
    <li className="group flex items-center gap-2 border-b border-border py-2 pl-2 pr-2 text-sm last:border-b-0 hover:bg-accent/40">
      <button
        type="button"
        onClick={onToggleExpanded}
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
        aria-label={expanded ? "Collapse children" : "Expand children"}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
      </button>
      <StatusIcon status={issue.status} onChange={onChangeStatus} />
      <Link
        to={issueHref}
        className="shrink-0 font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
        title={issue.title}
      >
        {issue.identifier ?? "—"}
      </Link>
      <Link
        to={issueHref}
        className="min-w-0 flex-1 truncate font-medium text-foreground no-underline hover:underline"
        title={issue.title}
      >
        {issue.title}
      </Link>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {docCount} docs
      </span>
    </li>
  );
}
