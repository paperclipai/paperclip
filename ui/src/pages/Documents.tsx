import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { relativeTime } from "../lib/utils";
import { Link } from "@/lib/router";
import { EmptyState } from "../components/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { FileText, Search, X } from "lucide-react";
import type { IssueDocumentSummary, Issue, Agent } from "@paperclipai/shared";

type DocumentEntry = {
  document: IssueDocumentSummary;
  issue: Issue;
};

export function Documents() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [search, setSearch] = useState("");
  const [keyFilter, setKeyFilter] = useState("all");
  const [agentFilter, setAgentFilter] = useState("all");

  useEffect(() => {
    setBreadcrumbs([{ label: "Documents" }]);
  }, [setBreadcrumbs]);

  const { data: issues, isLoading: issuesLoading } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const documentQueries = useQueries({
    queries: (issues ?? []).map((issue) => ({
      queryKey: queryKeys.issues.documents(issue.id),
      queryFn: () => issuesApi.listDocuments(issue.id),
      staleTime: 30_000,
    })),
  });

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const allDocuments = useMemo((): DocumentEntry[] => {
    if (!issues) return [];
    const entries: DocumentEntry[] = [];
    for (let i = 0; i < issues.length; i++) {
      const docs = documentQueries[i]?.data ?? [];
      for (const doc of docs) {
        entries.push({ document: doc, issue: issues[i] });
      }
    }
    return entries.sort(
      (a, b) => new Date(b.document.updatedAt).getTime() - new Date(a.document.updatedAt).getTime(),
    );
  }, [issues, documentQueries]);

  const uniqueKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const entry of allDocuments) keys.add(entry.document.key);
    return Array.from(keys).sort();
  }, [allDocuments]);

  const agentsWithDocuments = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of allDocuments) {
      if (entry.document.updatedByAgentId) ids.add(entry.document.updatedByAgentId);
    }
    return Array.from(ids)
      .map((id) => agentMap.get(id))
      .filter((a): a is Agent => !!a);
  }, [allDocuments, agentMap]);

  const filteredDocuments = useMemo(() => {
    return allDocuments.filter((entry) => {
      if (keyFilter !== "all" && entry.document.key !== keyFilter) return false;
      if (agentFilter !== "all" && entry.document.updatedByAgentId !== agentFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        const docTitle = (entry.document.title ?? entry.document.key).toLowerCase();
        const issueTitle = entry.issue.title.toLowerCase();
        const issueId = (entry.issue.identifier ?? "").toLowerCase();
        if (!docTitle.includes(q) && !issueTitle.includes(q) && !issueId.includes(q)) return false;
      }
      return true;
    });
  }, [allDocuments, keyFilter, agentFilter, search]);

  const documentsLoading = documentQueries.some((q) => q.isLoading);
  const hasActiveFilter = search !== "" || keyFilter !== "all" || agentFilter !== "all";

  function clearFilters() {
    setSearch("");
    setKeyFilter("all");
    setAgentFilter("all");
  }

  if (issuesLoading) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-9 w-48" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-8 w-32" />
          </div>
        </div>
        <div className="space-y-1">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-11 w-full rounded-none" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold">Documents</h1>
          {!documentsLoading && allDocuments.length > 0 && (
            <span className="text-sm text-muted-foreground">
              {filteredDocuments.length === allDocuments.length
                ? allDocuments.length
                : `${filteredDocuments.length} of ${allDocuments.length}`}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search documents or issues…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 pl-8 w-48 text-sm"
            />
          </div>

          {uniqueKeys.length > 0 && (
            <Select value={keyFilter} onValueChange={setKeyFilter}>
              <SelectTrigger className="h-8 w-32 text-sm">
                <SelectValue placeholder="All keys" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All keys</SelectItem>
                {uniqueKeys.map((key) => (
                  <SelectItem key={key} value={key}>
                    {key}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {agentsWithDocuments.length > 0 && (
            <Select value={agentFilter} onValueChange={setAgentFilter}>
              <SelectTrigger className="h-8 w-36 text-sm">
                <SelectValue placeholder="All agents" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All agents</SelectItem>
                {agentsWithDocuments.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {hasActiveFilter && (
            <button
              onClick={clearFilters}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="h-3.5 w-3.5" />
              Clear
            </button>
          )}
        </div>
      </div>

      {documentsLoading && allDocuments.length === 0 ? (
        <div className="space-y-1">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-11 w-full rounded-none" />
          ))}
        </div>
      ) : filteredDocuments.length === 0 ? (
        <EmptyState
          icon={FileText}
          message={
            hasActiveFilter
              ? "No documents match your filters."
              : "No documents have been created yet."
          }
          {...(hasActiveFilter ? { action: "Clear filters", onAction: clearFilters } : {})}
        />
      ) : (
        <div className="border border-border rounded-md overflow-hidden">
          {filteredDocuments.map((entry, i) => (
            <DocumentRow
              key={`${entry.issue.id}:${entry.document.key}`}
              entry={entry}
              agentMap={agentMap}
              isLast={i === filteredDocuments.length - 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DocumentRow({
  entry,
  agentMap,
  isLast,
}: {
  entry: DocumentEntry;
  agentMap: Map<string, Agent>;
  isLast: boolean;
}) {
  const { document, issue } = entry;
  const updatedByAgent = document.updatedByAgentId ? agentMap.get(document.updatedByAgentId) : null;
  const title = document.title ?? document.key;

  return (
    <Link
      to={`/issues/${issue.id}#document-${document.key}`}
      className={`flex items-center gap-3 px-4 py-2.5 hover:bg-accent/50 transition-colors group${!isLast ? " border-b border-border" : ""}`}
    >
      <FileText className="h-4 w-4 text-muted-foreground shrink-0" />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium truncate">{title}</span>
          {document.key !== title && (
            <Badge variant="secondary" className="text-xs shrink-0 font-mono">
              {document.key}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
          <span className="text-xs font-mono text-muted-foreground shrink-0">
            {issue.identifier ?? issue.id.slice(0, 8)}
          </span>
          <span className="text-xs text-muted-foreground">·</span>
          <span className="text-xs text-muted-foreground truncate">{issue.title}</span>
        </div>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        {updatedByAgent && (
          <span className="text-xs text-muted-foreground hidden sm:block">{updatedByAgent.name}</span>
        )}
        <span className="text-xs text-muted-foreground">
          {relativeTime(document.updatedAt)}
        </span>
      </div>
    </Link>
  );
}
