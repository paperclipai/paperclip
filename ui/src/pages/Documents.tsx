import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { relativeTime } from "../lib/utils";
import { Link } from "@/lib/router";
import { EmptyState } from "../components/EmptyState";
import { MarkdownBody } from "../components/MarkdownBody";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ArrowUpRight, FileText, History, Search, X } from "lucide-react";
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
  const [selected, setSelected] = useState<DocumentEntry | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Documents" }]);
  }, [setBreadcrumbs]);

  const { data: issues, isLoading: issuesLoading, error: issuesError } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: allDocs, isLoading: docsLoading, error: docsError } = useQuery({
    queryKey: queryKeys.documents.list(selectedCompanyId!),
    queryFn: () => issuesApi.listCompanyDocuments(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // Fetch body only when a document is selected
  const { data: selectedDocFull, isLoading: previewLoading } = useQuery({
    queryKey: queryKeys.issues.document(
      selected?.issue.id ?? "",
      selected?.document.key ?? "",
    ),
    queryFn: () => issuesApi.getDocument(selected!.issue.id, selected!.document.key),
    enabled: !!selected,
    staleTime: 30_000,
  });

  const issueMap = useMemo(() => {
    const map = new Map<string, Issue>();
    for (const issue of issues ?? []) map.set(issue.id, issue);
    return map;
  }, [issues]);

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const documentEntries = useMemo((): DocumentEntry[] => {
    if (!allDocs) return [];
    const entries: DocumentEntry[] = [];
    for (const doc of allDocs) {
      const issue = issueMap.get(doc.issueId);
      if (issue) entries.push({ document: doc, issue });
    }
    return entries;
  }, [allDocs, issueMap]);

  const uniqueKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const entry of documentEntries) keys.add(entry.document.key);
    return Array.from(keys).sort();
  }, [documentEntries]);

  const agentsWithDocuments = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of documentEntries) {
      if (entry.document.updatedByAgentId) ids.add(entry.document.updatedByAgentId);
    }
    return Array.from(ids)
      .map((id) => agentMap.get(id))
      .filter((a): a is Agent => !!a);
  }, [documentEntries, agentMap]);

  const filteredDocuments = useMemo(() => {
    return documentEntries.filter((entry) => {
      if (keyFilter !== "all" && entry.document.key !== keyFilter) return false;
      if (agentFilter !== "all" && entry.document.updatedByAgentId !== agentFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        const docTitle = (entry.document.title ?? entry.document.key).toLowerCase();
        const docKey = entry.document.key.toLowerCase();
        const issueTitle = entry.issue.title.toLowerCase();
        const issueId = (entry.issue.identifier ?? "").toLowerCase();
        if (!docTitle.includes(q) && !docKey.includes(q) && !issueTitle.includes(q) && !issueId.includes(q)) return false;
      }
      return true;
    });
  }, [documentEntries, keyFilter, agentFilter, search]);

  const hasActiveFilter = search !== "" || keyFilter !== "all" || agentFilter !== "all";

  function clearFilters() {
    setSearch("");
    setKeyFilter("all");
    setAgentFilter("all");
  }

  if (!selectedCompanyId) {
    return <EmptyState icon={History} message="Select a company to view documents." />;
  }

  const loadError = issuesError ?? docsError;
  if (loadError) {
    return (
      <p className="text-sm text-destructive">
        {loadError instanceof Error ? loadError.message : "Failed to load documents."}
      </p>
    );
  }

  if (issuesLoading || docsLoading) {
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
    <div className="flex flex-col gap-4 min-h-full">
      {/* Header + filters */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold">Documents</h1>
          {documentEntries.length > 0 && (
            <span className="text-sm text-muted-foreground">
              {filteredDocuments.length === documentEntries.length
                ? documentEntries.length
                : `${filteredDocuments.length} of ${documentEntries.length}`}
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

      {/* Content area: list + optional preview panel */}
      <div className="flex gap-4 min-w-0 items-start">
        {/* Document list */}
        <div className={selected ? "w-1/2 min-w-0" : "flex-1 min-w-0"}>
          {filteredDocuments.length === 0 ? (
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
                  isSelected={
                    selected?.issue.id === entry.issue.id &&
                    selected?.document.key === entry.document.key
                  }
                  onSelect={setSelected}
                />
              ))}
            </div>
          )}
        </div>

        {/* Preview panel */}
        {selected && (
          <div className="w-1/2 min-w-0 border border-border rounded-md overflow-hidden flex flex-col">
            <div className="flex items-start justify-between gap-2 px-4 py-3 border-b border-border bg-muted/30 shrink-0">
              <div className="min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm font-semibold truncate">
                    {selected.document.title ?? selected.document.key}
                  </span>
                  {selected.document.title && (
                    <Badge variant="secondary" className="text-xs font-mono shrink-0">
                      {selected.document.key}
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className="text-xs font-mono text-muted-foreground">
                    {selected.issue.identifier ?? selected.issue.id.slice(0, 8)}
                  </span>
                  <span className="text-xs text-muted-foreground">·</span>
                  <span className="text-xs text-muted-foreground truncate">{selected.issue.title}</span>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button variant="ghost" size="icon-sm" asChild>
                  <Link
                    to={`/issues/${selected.issue.id}#document-${selected.document.key}`}
                    title="Open in issue"
                  >
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  </Link>
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setSelected(null)}
                  title="Close preview"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            <div className="p-4 overflow-y-auto">
              {previewLoading ? (
                <div className="space-y-3">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-5/6" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-2/3" />
                </div>
              ) : selectedDocFull ? (
                <MarkdownBody className="text-sm">{selectedDocFull.body}</MarkdownBody>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function DocumentRow({
  entry,
  agentMap,
  isLast,
  isSelected,
  onSelect,
}: {
  entry: DocumentEntry;
  agentMap: Map<string, Agent>;
  isLast: boolean;
  isSelected: boolean;
  onSelect: (entry: DocumentEntry) => void;
}) {
  const { document, issue } = entry;
  const updatedByAgent = document.updatedByAgentId ? agentMap.get(document.updatedByAgentId) : null;
  const title = document.title ?? document.key;

  return (
    <button
      type="button"
      onClick={() => onSelect(entry)}
      className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors${!isLast ? " border-b border-border" : ""}${isSelected ? " bg-accent" : " hover:bg-accent/50"}`}
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
    </button>
  );
}
