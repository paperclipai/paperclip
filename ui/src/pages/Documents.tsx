import { useEffect, useMemo, useRef, useState, startTransition, useDeferredValue } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { FileText } from "lucide-react";
import { documentsApi } from "../api/documents";
import { projectsApi } from "../api/projects";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { issueUrl, relativeTime } from "../lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const SEARCH_DEBOUNCE_MS = 150;
const ALL_PROJECTS_VALUE = "__all__";

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
    }),
    [projectFilter, deferredSearch],
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

  if (!selectedCompanyId) {
    return <EmptyState icon={FileText} message="Select a company to view documents." />;
  }

  const showSkeleton = isLoading && !documents;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          type="search"
          value={searchDraft}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search documents..."
          data-page-search-target="true"
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 sm:max-w-[280px]"
        />
        <Select value={projectFilter} onValueChange={setProjectFilter}>
          <SelectTrigger className="h-9 w-full sm:w-[200px]">
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
        {documents && (
          <span className="text-xs text-muted-foreground sm:ml-auto">
            {documents.length} {documents.length === 1 ? "document" : "documents"}
          </span>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {showSkeleton && <PageSkeleton variant="list" />}

      {!showSkeleton && documents && documents.length === 0 && (
        <EmptyState
          icon={FileText}
          message={
            committedSearch || projectFilter !== ALL_PROJECTS_VALUE
              ? "No documents match the current filters."
              : "No documents yet. Documents created on issues will show up here."
          }
        />
      )}

      {!showSkeleton && documents && documents.length > 0 && (
        <div className="overflow-hidden rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Document</th>
                <th className="px-3 py-2 font-medium">Issue</th>
                <th className="px-3 py-2 font-medium">Project</th>
                <th className="px-3 py-2 font-medium">Author</th>
                <th className="px-3 py-2 font-medium text-right">Rev</th>
                <th className="px-3 py-2 font-medium text-right">Updated</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => {
                const issueHref = issuePrefix
                  ? `/${issuePrefix}/issues/${doc.issue.identifier ?? doc.issue.id}`
                  : issueUrl({ id: doc.issue.id, identifier: doc.issue.identifier });
                const author =
                  (doc.updatedByAgentId && agentNameById.get(doc.updatedByAgentId)) ||
                  (doc.createdByAgentId && agentNameById.get(doc.createdByAgentId)) ||
                  (doc.updatedByUserId ? "user" : null);
                return (
                  <tr key={doc.id} className="border-b border-border last:border-0 hover:bg-accent/30">
                    <td className="px-3 py-2 align-top">
                      <Link
                        to={`${issueHref}#doc-${doc.key}`}
                        className="block text-foreground hover:underline"
                      >
                        <div className="flex items-center gap-2">
                          <span className="shrink-0 rounded-full border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                            {doc.key}
                          </span>
                          <span className="font-medium">{doc.title ?? doc.key}</span>
                        </div>
                      </Link>
                    </td>
                    <td className="px-3 py-2 align-top text-muted-foreground">
                      <Link to={issueHref} className="hover:text-foreground hover:underline">
                        {doc.issue.identifier ?? "—"}{" "}
                        <span className="text-xs">{doc.issue.title}</span>
                      </Link>
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
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
