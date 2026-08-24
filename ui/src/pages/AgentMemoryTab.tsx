import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Search,
  X,
  Brain,
  Clock,
  Trash2,
  Eye,
  FileText,
  MessageSquare,
  BookOpen,
  Terminal,
  Activity,
  AlertCircle,
  HardDrive,
  Loader2,
  MoreHorizontal,
  Database,
  Info,
  Settings2,
} from "lucide-react";
import { memoryApi } from "../api/memory";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { ExtractionJobsDashboard } from "../components/ExtractionJobsDashboard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { MemorySnippet } from "@paperclipai/shared";

// ─── Constants ──────────────────────────────────────────────────────────────

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 300;

// ─── Helpers (shared with MemoryBrowser) ─────────────────────────────────────

function sourceKindIcon(kind?: string) {
  switch (kind) {
    case "issue_comment": return <MessageSquare className="h-3.5 w-3.5" />;
    case "issue_document": return <FileText className="h-3.5 w-3.5" />;
    case "issue": return <HardDrive className="h-3.5 w-3.5" />;
    case "run": return <Terminal className="h-3.5 w-3.5" />;
    case "activity": return <Activity className="h-3.5 w-3.5" />;
    case "manual_note": return <BookOpen className="h-3.5 w-3.5" />;
    default: return <Database className="h-3.5 w-3.5" />;
  }
}

function sourceKindLabel(kind?: string): string {
  switch (kind) {
    case "issue_comment": return "Comment";
    case "issue_document": return "Document";
    case "issue": return "Issue";
    case "run": return "Run";
    case "activity": return "Activity";
    case "manual_note": return "Manual Note";
    case "external_document": return "External Doc";
    default: return "Unknown";
  }
}

function formatDate(dateStr?: string): string {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

// ─── Memory Config Card ─────────────────────────────────────────────────────

function AgentMemoryConfigCard({
  companyId,
  agentId,
}: {
  companyId: string;
  agentId: string;
}) {
  const configQuery = useQuery({
    queryKey: queryKeys.memory.agentConfig(companyId, agentId),
    queryFn: () => memoryApi.getAgentMemoryConfig(companyId, agentId),
    enabled: !!companyId && !!agentId,
  });

  if (configQuery.isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (configQuery.error) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border p-4 text-sm text-destructive">
        <AlertCircle className="h-4 w-4" />
        {(configQuery.error as Error).message}
      </div>
    );
  }

  const config = configQuery.data;

  if (!config) {
    return (
      <div className="rounded-lg border border-border p-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Info className="h-4 w-4" />
          No memory binding configured for this agent. Configure one in Company Settings → Memory.
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="text-xs font-semibold uppercase text-muted-foreground flex items-center gap-1.5">
        <Settings2 className="h-3.5 w-3.5" />
        Memory Configuration
      </div>
      <div className="space-y-2 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Binding</span>
          <span className="font-medium">{config.binding.key}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Provider</span>
          <span>{config.binding.providerType}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Status</span>
          <Badge
            variant={config.binding.enabled ? "default" : "secondary"}
            className="text-[10px]"
          >
            {config.binding.enabled ? "Enabled" : "Disabled"}
          </Badge>
        </div>
        {config.target && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Override</span>
            <Badge variant="outline" className="text-[10px]">
              {config.target.targetType === "agent" ? "Agent-specific" : "Company default"}
            </Badge>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Record Detail Sheet ────────────────────────────────────────────────────

function MemoryDetailSheet({
  record,
  open,
  onOpenChange,
  onForget,
}: {
  record: MemorySnippet | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onForget: (handle: { providerKey: string; providerRecordId: string }) => void;
}) {
  if (!record) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader className="space-y-1">
          <SheetTitle className="flex items-center gap-2 text-base">
            <Brain className="h-4 w-4" />
            Memory Record
          </SheetTitle>
          <SheetDescription className="text-xs">
            ID: {record.handle.providerRecordId}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-5">
          {/* Text content */}
          <div>
            <h3 className="text-xs font-semibold uppercase text-muted-foreground mb-2">Content</h3>
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <p className="text-sm whitespace-pre-wrap break-words">{record.text}</p>
            </div>
          </div>

          {/* Summary if available */}
          {record.summary && (
            <div>
              <h3 className="text-xs font-semibold uppercase text-muted-foreground mb-2">Summary</h3>
              <p className="text-sm text-muted-foreground">{record.summary}</p>
            </div>
          )}

          {/* Score if available */}
          {record.score !== undefined && (
            <div>
              <h3 className="text-xs font-semibold uppercase text-muted-foreground mb-2">Relevance Score</h3>
              <span className="inline-flex items-center rounded-md bg-accent px-2 py-1 text-xs font-medium">
                {(record.score * 100).toFixed(1)}%
              </span>
            </div>
          )}

          <Separator />

          {/* Source info */}
          <div>
            <h3 className="text-xs font-semibold uppercase text-muted-foreground mb-2">Source</h3>
            {record.source ? (
              <div className="space-y-1.5 text-sm">
                <div className="flex items-center gap-2 text-muted-foreground">
                  {sourceKindIcon(record.source.kind)}
                  <span>{sourceKindLabel(record.source.kind)}</span>
                </div>
                {record.source.issueId && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">Issue:</span>
                    <a
                      href={`/issues/${record.source.issueId}`}
                      className="text-xs font-mono text-primary underline underline-offset-2 hover:text-primary/80"
                    >
                      {record.source.issueId.slice(0, 8)}...
                    </a>
                  </div>
                )}
                {record.source.runId && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">Run:</span>
                    <a
                      href={`/agents/${record.source.companyId}/runs/${record.source.runId}`}
                      className="text-xs font-mono text-primary underline underline-offset-2 hover:text-primary/80"
                    >
                      {record.source.runId.slice(0, 8)}...
                    </a>
                  </div>
                )}
                {record.source.commentId && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">Comment:</span>
                    <a
                      href={`/issues/${record.source.issueId ?? ""}?comment=${record.source.commentId}`}
                      className="text-xs font-mono text-primary underline underline-offset-2 hover:text-primary/80"
                    >
                      {record.source.commentId.slice(0, 8)}...
                    </a>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Unknown source</p>
            )}
          </div>

          {/* Metadata */}
          {record.metadata && Object.keys(record.metadata).length > 0 && (
            <>
              <Separator />
              <div>
                <h3 className="text-xs font-semibold uppercase text-muted-foreground mb-2">Metadata</h3>
                <div className="rounded-lg border border-border bg-muted/30 p-3">
                  <pre className="text-xs whitespace-pre-wrap break-words">
                    {JSON.stringify(record.metadata, null, 2)}
                  </pre>
                </div>
              </div>
            </>
          )}

          {/* Actions */}
          <Separator />
          <div className="flex gap-2">
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                onForget(record.handle);
                onOpenChange(false);
              }}
            >
              <Trash2 className="h-3.5 w-3.5 mr-1.5" />
              Forget
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─── Records Browser ────────────────────────────────────────────────────────

function AgentRecordsBrowser({
  companyId,
  agentId,
  bindingKey,
}: {
  companyId: string;
  agentId: string;
  bindingKey: string;
}) {
  const queryClient = useQueryClient();
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [draftSearch, setDraftSearch] = useState("");

  // Detail sheet
  const [selectedRecord, setSelectedRecord] = useState<MemorySnippet | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const isSearching = searchQuery.trim().length > 0;

  // Sync draft search → committed search on debounce
  useEffect(() => {
    const trimmed = draftSearch.trim();
    if (trimmed === searchQuery) return;
    const handle = window.setTimeout(() => {
      setSearchQuery(trimmed);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [draftSearch, searchQuery]);

  // Build scope for agent
  const scopeJson = useMemo(
    () => JSON.stringify({ agentId }),
    [agentId],
  );

  const listQuery = useInfiniteQuery({
    queryKey: [
      "memory",
      companyId,
      "list",
      bindingKey,
      searchQuery,
      agentId,
    ],
    queryFn: ({ pageParam }) => {
      if (isSearching) {
        return memoryApi.query(companyId, {
          bindingKey,
          q: searchQuery,
          topK: PAGE_SIZE,
          intent: "browse",
        }).then((bundle) => ({
          items: bundle.snippets,
          nextCursor: undefined as string | undefined,
        }));
      }

      return memoryApi.list(companyId, {
        bindingKey,
        limit: PAGE_SIZE,
        cursor: pageParam,
        scope: scopeJson,
      });
    },
    enabled: !!companyId && !!bindingKey,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  // Forget
  const forgetMutation = useMutation({
    mutationFn: (handle: { providerKey: string; providerRecordId: string }) =>
      memoryApi.forget(companyId, [handle]),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["memory", companyId] });
    },
  });

  // Infinite scroll
  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target || listQuery.hasNextPage === false || listQuery.isFetchingNextPage || isSearching) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        void listQuery.fetchNextPage();
      }
    }, { rootMargin: "320px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [listQuery.fetchNextPage, listQuery.hasNextPage, listQuery.isFetchingNextPage, isSearching]);

  const records = useMemo(
    () => listQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [listQuery.data],
  );

  const showInfiniteScroll = !isSearching && listQuery.hasNextPage;

  return (
    <div className="space-y-3">
      {/* Search */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={draftSearch}
          onChange={(event) => setDraftSearch(event.currentTarget.value)}
          placeholder="Search this agent's memory records..."
          aria-label="Search agent memory"
          className="h-9 pl-9 pr-9 text-sm"
        />
        {draftSearch.length > 0 ? (
          <button
            type="button"
            onClick={() => {
              setDraftSearch("");
              setSearchQuery("");
            }}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      {/* Results count */}
      {isSearching && (
        <p className="text-xs text-muted-foreground">
          {listQuery.isFetching
            ? "Searching..."
            : `${records.length} result${records.length !== 1 ? "s" : ""} for "${searchQuery}"`
          }
        </p>
      )}

      {/* Error */}
      {listQuery.error && (
        <div className="flex items-center gap-2 rounded-lg border border-border p-4 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" />
          {(listQuery.error as Error).message}
        </div>
      )}

      {/* Records */}
      {listQuery.isPending ? (
        <PageSkeleton variant="list" />
      ) : records.length === 0 ? (
        <EmptyState
          icon={Brain}
          message={isSearching ? "No memory records match your search." : "No memory records for this agent yet."}
        />
      ) : (
        <>
          <div className="space-y-2">
            {records.map((record) => (
              <AgentMemoryRecordCard
                key={`${record.handle.providerKey}:${record.handle.providerRecordId}`}
                record={record}
                onSelect={() => {
                  setSelectedRecord(record);
                  setDetailOpen(true);
                }}
                onForget={(handle) => forgetMutation.mutate(handle)}
              />
            ))}
          </div>

          <div
            ref={loadMoreRef}
            className="flex min-h-10 items-center justify-center pb-2 text-xs text-muted-foreground"
          >
            {listQuery.isFetchingNextPage ? (
              <span className="flex items-center gap-2">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading more records...
              </span>
            ) : showInfiniteScroll ? null : listQuery.isFetching ? (
              "Updating records..."
            ) : null}
          </div>
        </>
      )}

      <MemoryDetailSheet
        record={selectedRecord}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        onForget={(handle) => forgetMutation.mutate(handle)}
      />

      {forgetMutation.isPending && (
        <div className="fixed bottom-4 right-4 flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2 shadow-lg text-sm">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Forgetting record...
        </div>
      )}
    </div>
  );
}

// ─── Agent Memory Record Card ────────────────────────────────────────────────

function AgentMemoryRecordCard({
  record,
  onSelect,
  onForget,
}: {
  record: MemorySnippet;
  onSelect: () => void;
  onForget: (handle: { providerKey: string; providerRecordId: string }) => void;
}) {
  return (
    <div className="group relative rounded-lg border border-border bg-card p-3 transition-colors hover:border-border/80 hover:bg-accent/30">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
            {record.source && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground bg-muted/50">
                    {sourceKindIcon(record.source.kind)}
                    {sourceKindLabel(record.source.kind)}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">
                  Source: {sourceKindLabel(record.source.kind)}
                </TooltipContent>
              </Tooltip>
            )}
            {record.score !== undefined && (
              <span className="text-[10px] text-muted-foreground bg-accent/30 rounded px-1 py-0.5">
                {(record.score * 100).toFixed(0)}% match
              </span>
            )}
            {(() => {
              const createdAt = record.metadata?.createdAt;
              if (typeof createdAt === "string") {
                return (
                  <span className="text-[10px] text-muted-foreground ml-auto">
                    {formatDate(createdAt)}
                  </span>
                );
              }
              return null;
            })()}
          </div>

          <p className="text-sm leading-relaxed text-foreground/90 line-clamp-3">
            {record.text}
          </p>

          {record.summary && (
            <p className="mt-1 text-xs text-muted-foreground italic line-clamp-1">
              {record.summary}
            </p>
          )}
        </div>

        <div className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="h-7 w-7">
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-36">
              <DropdownMenuItem onClick={onSelect}>
                <Eye className="h-3.5 w-3.5 mr-2" />
                View details
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={() => onForget(record.handle)}
              >
                <Trash2 className="h-3.5 w-3.5 mr-2" />
                Forget
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function AgentMemoryTab({
  companyId,
  agentId,
}: {
  companyId: string;
  agentId: string;
}) {
  const [activeTab, setActiveTab] = useState("records");

  // Get the agent's binding key from the config
  const configQuery = useQuery({
    queryKey: queryKeys.memory.agentConfig(companyId, agentId),
    queryFn: () => memoryApi.getAgentMemoryConfig(companyId, agentId),
    enabled: !!companyId && !!agentId,
  });

  const bindingKey = configQuery.data?.binding?.key;

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Config summary */}
      <AgentMemoryConfigCard companyId={companyId} agentId={agentId} />

      {/* Tabs: Records / Operations / Extractions */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="records" className="text-xs">
            <Brain className="h-3.5 w-3.5 mr-1.5" />
            Records
          </TabsTrigger>
          <TabsTrigger value="operations" className="text-xs">
            <Activity className="h-3.5 w-3.5 mr-1.5" />
            Operations
          </TabsTrigger>
          <TabsTrigger value="extractions" className="text-xs">
            <Database className="h-3.5 w-3.5 mr-1.5" />
            Extractions
          </TabsTrigger>
        </TabsList>

        <TabsContent value="records" className="mt-4">
          {bindingKey ? (
            <AgentRecordsBrowser
              companyId={companyId}
              agentId={agentId}
              bindingKey={bindingKey}
            />
          ) : (
            <EmptyState
              icon={Database}
              message="No memory binding configured for this agent."
            />
          )}
        </TabsContent>

        <TabsContent value="operations" className="mt-4">
          <AgentOperationsTab companyId={companyId} />
        </TabsContent>

        <TabsContent value="extractions" className="mt-4">
          <ExtractionJobsDashboard companyId={companyId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─── Agent Operations Tab (copy of OperationsTab from MemoryBrowser) ─────────

function AgentOperationsTab({ companyId }: { companyId: string }) {
  const { data, isLoading, error } = useQuery<import("../api/memory").MemoryOperation[]>({
    queryKey: queryKeys.memory.operations(companyId),
    queryFn: () => memoryApi.operations(companyId) as Promise<import("../api/memory").MemoryOperation[]>,
    enabled: !!companyId,
  });

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border p-4 text-sm text-destructive">
        <AlertCircle className="h-4 w-4" />
        {(error as Error).message}
      </div>
    );
  }

  if (!data || data.length === 0) {
    return <EmptyState icon={Clock} message="No memory operations recorded yet." />;
  }

  return (
    <div className="border border-border rounded-lg divide-y divide-border">
      {data.map((op) => (
        <div key={op.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
          <div className="flex items-center gap-2 min-w-0">
            <OperationBadge type={op.operationType} success={op.success} />
            <span className="text-xs text-muted-foreground truncate">
              {op.providerKey && `${op.providerKey} · `}
              {op.recordCount} record{op.recordCount !== 1 ? "s" : ""}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* Latency */}
            {op.latencyMs !== undefined && op.latencyMs > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                    {op.latencyMs >= 1000
                      ? `${(op.latencyMs / 1000).toFixed(1)}s`
                      : `${op.latencyMs}ms`}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="left">
                  Latency: {op.latencyMs}ms
                </TooltipContent>
              </Tooltip>
            )}
            {/* Cost */}
            {op.usageJson && typeof (op.usageJson as Record<string, unknown>).costCents === "number" && (
              <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                ${(Number((op.usageJson as Record<string, unknown>).costCents) / 100).toFixed(4)}
              </span>
            )}
            {op.errorMessage && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <AlertCircle className="h-3.5 w-3.5 text-destructive" />
                </TooltipTrigger>
                <TooltipContent side="left">
                  {op.errorMessage}
                </TooltipContent>
              </Tooltip>
            )}
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {formatDate(op.createdAt)}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function OperationBadge({ type, success }: { type: string; success: boolean }) {
  const color = success
    ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300"
    : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300";
  return (
    <span className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium", color)}>
      {type}
    </span>
  );
}
