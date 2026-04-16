import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Filter,
} from "lucide-react";
import { Link } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { memoryApi, type MemoryOperation } from "../api/memory";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const PAGE_SIZE = 50;

const OP_TYPE_COLORS: Record<string, string> = {
  write: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  query: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  forget: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
  browse: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400",
  correct: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
};

function formatTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function OperationRow({
  op,
  agentName,
}: {
  op: MemoryOperation;
  agentName: string | null;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-b border-border last:border-b-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-accent/30 transition-colors text-left"
      >
        {op.success ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
        ) : (
          <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />
        )}
        <span
          className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${OP_TYPE_COLORS[op.operationType] ?? "bg-muted text-muted-foreground"}`}
        >
          {op.operationType}
        </span>
        <span className="text-muted-foreground truncate max-w-[120px]">
          {op.bindingKey ?? op.bindingId.slice(0, 8)}
        </span>
        {agentName && (
          <span className="text-muted-foreground truncate max-w-[120px]">
            {agentName}
          </span>
        )}
        {op.latencyMs != null && (
          <span className="text-xs text-muted-foreground">{op.latencyMs}ms</span>
        )}
        <span className="ml-auto text-xs text-muted-foreground whitespace-nowrap">
          {formatTime(op.createdAt)}
        </span>
      </button>

      {expanded && (
        <div className="px-4 pb-3 pt-1 text-xs space-y-1.5 bg-muted/20">
          <div className="grid grid-cols-[100px_1fr] gap-1">
            <span className="text-muted-foreground">Operation ID</span>
            <span className="font-mono">{op.id}</span>

            <span className="text-muted-foreground">Binding</span>
            <span>
              {op.bindingKey ?? "—"}{" "}
              <span className="text-muted-foreground">({op.providerKey ?? "—"})</span>
            </span>

            {op.agentId && (
              <>
                <span className="text-muted-foreground">Agent</span>
                <span>{agentName ?? op.agentId}</span>
              </>
            )}

            {op.issueId && (
              <>
                <span className="text-muted-foreground">Issue</span>
                <Link to={`/issues/${op.issueId}`} className="text-primary hover:underline">
                  {op.issueId.slice(0, 8)}
                </Link>
              </>
            )}

            {op.runId && (
              <>
                <span className="text-muted-foreground">Run</span>
                <span className="font-mono">{op.runId.slice(0, 8)}</span>
              </>
            )}

            {op.error && (
              <>
                <span className="text-muted-foreground">Error</span>
                <span className="text-destructive">{op.error}</span>
              </>
            )}

            {op.sourceRef && (
              <>
                <span className="text-muted-foreground">Source</span>
                <span className="font-mono break-all">
                  {JSON.stringify(op.sourceRef)}
                </span>
              </>
            )}

            {op.usage && (
              <>
                <span className="text-muted-foreground">Usage</span>
                <span className="font-mono break-all">
                  {JSON.stringify(op.usage)}
                </span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function MemoryOperations() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [page, setPage] = useState(0);
  const [filterType, setFilterType] = useState<string>("");
  const [filterSuccess, setFilterSuccess] = useState<string>("");
  const [filterBindingId, setFilterBindingId] = useState<string>("");
  const [filterAgentId, setFilterAgentId] = useState<string>("");
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Memory", href: "/memory" },
      { label: "Operations" },
    ]);
  }, [selectedCompany, setBreadcrumbs]);

  const filters: Record<string, string | number | undefined> = {
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    ...(filterType ? { operationType: filterType } : {}),
    ...(filterSuccess ? { success: filterSuccess } : {}),
    ...(filterBindingId ? { bindingId: filterBindingId } : {}),
    ...(filterAgentId ? { agentId: filterAgentId } : {}),
  };

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.memory.operations(selectedCompanyId!, filters),
    queryFn: () => memoryApi.listOperations(selectedCompanyId!, filters),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: bindings } = useQuery({
    queryKey: queryKeys.memory.bindings(selectedCompanyId!),
    queryFn: () => memoryApi.listBindings(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentMap = new Map((agents ?? []).map((a: { id: string; name: string }) => [a.id, a.name]));

  const totalPages = Math.ceil((data?.total ?? 0) / PAGE_SIZE);

  if (!selectedCompanyId) return null;

  return (
    <div className="mx-auto max-w-4xl py-8 px-4">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Activity className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Memory Operations</h1>
          {data && (
            <span className="text-sm text-muted-foreground">
              {data.total} total
            </span>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowFilters(!showFilters)}
        >
          <Filter className="h-3.5 w-3.5 mr-1" /> Filters
        </Button>
      </div>

      {showFilters && (
        <div className="flex flex-wrap items-center gap-3 mb-4 p-3 rounded-lg border border-border bg-muted/20">
          <div className="flex items-center gap-1.5">
            <label className="text-xs text-muted-foreground">Type</label>
            <select
              className="rounded-md border border-border bg-background px-2 py-1 text-sm"
              value={filterType}
              onChange={(e) => { setFilterType(e.target.value); setPage(0); }}
            >
              <option value="">All</option>
              <option value="write">write</option>
              <option value="query">query</option>
              <option value="forget">forget</option>
              <option value="browse">browse</option>
              <option value="correct">correct</option>
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <label className="text-xs text-muted-foreground">Status</label>
            <select
              className="rounded-md border border-border bg-background px-2 py-1 text-sm"
              value={filterSuccess}
              onChange={(e) => { setFilterSuccess(e.target.value); setPage(0); }}
            >
              <option value="">All</option>
              <option value="true">Success</option>
              <option value="false">Failed</option>
            </select>
          </div>
          {bindings && bindings.length > 0 && (
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground">Binding</label>
              <select
                className="rounded-md border border-border bg-background px-2 py-1 text-sm"
                value={filterBindingId}
                onChange={(e) => { setFilterBindingId(e.target.value); setPage(0); }}
              >
                <option value="">All</option>
                {bindings.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.key}
                  </option>
                ))}
              </select>
            </div>
          )}
          {agents && (agents as { id: string; name: string }[]).length > 0 && (
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground">Agent</label>
              <select
                className="rounded-md border border-border bg-background px-2 py-1 text-sm"
                value={filterAgentId}
                onChange={(e) => { setFilterAgentId(e.target.value); setPage(0); }}
              >
                <option value="">All</option>
                {(agents as { id: string; name: string }[]).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setFilterType("");
              setFilterSuccess("");
              setFilterBindingId("");
              setFilterAgentId("");
              setPage(0);
            }}
          >
            Clear
          </Button>
        </div>
      )}

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        {isLoading && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            Loading operations...
          </div>
        )}

        {!isLoading && data?.items.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            No operations found
          </div>
        )}

        {data?.items.map((op) => (
          <OperationRow
            key={op.id}
            op={op}
            agentName={op.agentId ? agentMap.get(op.agentId) ?? null : null}
          />
        ))}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            <ChevronLeft className="h-4 w-4 mr-1" /> Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page + 1} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages - 1}
            onClick={() => setPage(page + 1)}
          >
            Next <ChevronRight className="h-4 w-4 ml-1" />
          </Button>
        </div>
      )}
    </div>
  );
}
