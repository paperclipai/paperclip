import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePageTitle } from "../hooks/usePageTitle";
import { activityApi } from "../api/activity";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Shield, Search, Filter, Download, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import type { ActivityEvent } from "@ironworksai/shared";

/* ------------------------------------------------------------------ */
/*  Administrative action types                                        */
/* ------------------------------------------------------------------ */

const ADMIN_ACTIONS = new Set([
  "create", "update", "delete", "archive", "restore",
  "invite", "approve", "reject", "assign", "unassign",
  "configure", "enable", "disable", "grant", "revoke",
  "terminate", "activate", "pause", "resume",
  "deploy", "publish", "unpublish",
  "pin", "unpin", "escalate",
]);

function isAdminAction(action: string): boolean {
  // Match exact or prefix-based admin actions
  for (const a of ADMIN_ACTIONS) {
    if (action === a || action.startsWith(`${a}_`) || action.endsWith(`_${a}`)) return true;
  }
  // Also include settings/config changes
  if (action.includes("setting") || action.includes("config") || action.includes("permission")) return true;
  return true; // Show all events in audit log - they are all auditable
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatTimestamp(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatAction(action: string): string {
  return action.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatEntityType(type: string): string {
  return type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function actionColor(action: string): string {
  if (action.startsWith("create") || action.startsWith("add")) return "text-emerald-600 dark:text-emerald-400";
  if (action.startsWith("delete") || action.startsWith("remove") || action.startsWith("terminate")) return "text-red-600 dark:text-red-400";
  if (action.startsWith("update") || action.startsWith("edit") || action.startsWith("configure")) return "text-blue-600 dark:text-blue-400";
  return "text-foreground";
}

const PAGE_SIZE = 50;

/* ------------------------------------------------------------------ */
/*  Audit Log Page                                                     */
/* ------------------------------------------------------------------ */

export function AuditLog() {
  usePageTitle("Audit Log");
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [search, setSearch] = useState("");
  const [actorFilter, setActorFilter] = useState("all");
  const [actionFilter, setActionFilter] = useState("all");
  const [page, setPage] = useState(0);

  useEffect(() => {
    setBreadcrumbs([{ label: "Audit Log" }]);
  }, [setBreadcrumbs]);

  const { data: events, isLoading, error } = useQuery({
    queryKey: [...queryKeys.activity(selectedCompanyId!), "audit"],
    queryFn: () => activityApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agentSlims = [] } = useQuery({
    queryKey: queryKeys.agents.slim(selectedCompanyId!),
    queryFn: () => agentsApi.slim(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of agentSlims) map.set(a.id, a.name);
    return map;
  }, [agentSlims]);

  // Derive unique actors and actions for filters
  const { uniqueActors, uniqueActions } = useMemo(() => {
    const actors = new Map<string, string>();
    const actions = new Set<string>();
    for (const e of events ?? []) {
      const name = e.actorType === "agent"
        ? agentNameMap.get(e.actorId) ?? "Agent"
        : e.actorType === "system"
          ? "System"
          : "User";
      actors.set(e.actorId, name);
      actions.add(e.action);
    }
    return {
      uniqueActors: [...actors.entries()].sort((a, b) => a[1].localeCompare(b[1])),
      uniqueActions: [...actions].sort(),
    };
  }, [events, agentNameMap]);

  // Filter and search
  const filtered = useMemo(() => {
    let list = events ?? [];
    if (actorFilter !== "all") list = list.filter((e) => e.actorId === actorFilter);
    if (actionFilter !== "all") list = list.filter((e) => e.action === actionFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (e) =>
          e.action.toLowerCase().includes(q) ||
          e.entityType.toLowerCase().includes(q) ||
          (agentNameMap.get(e.actorId) ?? "").toLowerCase().includes(q) ||
          JSON.stringify(e.details ?? {}).toLowerCase().includes(q),
      );
    }
    return list;
  }, [events, actorFilter, actionFilter, search, agentNameMap]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const pageEvents = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const handleExport = () => {
    const rows = filtered.map((e) => ({
      timestamp: formatTimestamp(e.createdAt),
      actor: e.actorType === "agent" ? agentNameMap.get(e.actorId) ?? e.actorId : e.actorType,
      actorType: e.actorType,
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId,
      details: JSON.stringify(e.details ?? {}),
    }));
    const csv = [
      Object.keys(rows[0] ?? {}).join(","),
      ...rows.map((r) =>
        Object.values(r)
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(","),
      ),
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!selectedCompanyId) {
    return <EmptyState icon={Shield} message="Select a company to view the audit log." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  if (error) {
    return (
      <EmptyState
        icon={Shield}
        message={`Failed to load audit log: ${error instanceof Error ? error.message : "Unknown error"}`}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Audit Log</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Company-wide record of who did what, and when.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={handleExport} disabled={filtered.length === 0}>
          <Download className="h-3.5 w-3.5 mr-1.5" />
          Export CSV
        </Button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative w-48 sm:w-64">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            placeholder="Search audit log..."
            className="pl-7 text-xs h-8"
          />
        </div>
        <Select value={actorFilter} onValueChange={(v) => { setActorFilter(v); setPage(0); }}>
          <SelectTrigger className="h-8 w-auto min-w-[140px] text-xs">
            <Filter className="h-3 w-3 mr-1" />
            <SelectValue placeholder="All actors" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All actors</SelectItem>
            {uniqueActors.map(([id, name]) => (
              <SelectItem key={id} value={id}>{name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={actionFilter} onValueChange={(v) => { setActionFilter(v); setPage(0); }}>
          <SelectTrigger className="h-8 w-auto min-w-[140px] text-xs">
            <Filter className="h-3 w-3 mr-1" />
            <SelectValue placeholder="All actions" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All actions</SelectItem>
            {uniqueActions.map((a) => (
              <SelectItem key={a} value={a}>{formatAction(a)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground ml-auto">
          {filtered.length} event{filtered.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <EmptyState icon={Shield} message="No audit events match your filters." />
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/30 border-b border-border">
                  <th className="text-left px-4 py-2.5 font-medium text-muted-foreground w-40">Timestamp</th>
                  <th className="text-left px-4 py-2.5 font-medium text-muted-foreground w-32">Actor</th>
                  <th className="text-left px-4 py-2.5 font-medium text-muted-foreground w-32">Action</th>
                  <th className="text-left px-4 py-2.5 font-medium text-muted-foreground w-28">Entity</th>
                  <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Details</th>
                </tr>
              </thead>
              <tbody>
                {pageEvents.map((event) => {
                  const actorName = event.actorType === "agent"
                    ? agentNameMap.get(event.actorId) ?? "Agent"
                    : event.actorType === "system"
                      ? "System"
                      : "User";
                  const detailStr = event.details
                    ? Object.entries(event.details)
                        .filter(([, v]) => v !== null && v !== undefined)
                        .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
                        .join(", ")
                    : "";

                  return (
                    <tr key={event.id} className="border-b border-border/50 hover:bg-accent/20 transition-colors">
                      <td className="px-4 py-2 text-muted-foreground tabular-nums whitespace-nowrap">
                        {formatTimestamp(event.createdAt)}
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-1.5">
                          <span className={cn(
                            "text-[9px] font-medium px-1 py-0 rounded-full leading-tight shrink-0",
                            event.actorType === "agent" ? "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400"
                              : event.actorType === "system" ? "bg-muted text-muted-foreground"
                              : "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
                          )}>
                            {event.actorType === "agent" ? "AGT" : event.actorType === "system" ? "SYS" : "USR"}
                          </span>
                          <span className="truncate">{actorName}</span>
                        </div>
                      </td>
                      <td className={cn("px-4 py-2 font-medium", actionColor(event.action))}>
                        {formatAction(event.action)}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {formatEntityType(event.entityType)}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground truncate max-w-[300px]" title={detailStr}>
                        {detailStr || "-"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-2 bg-muted/20 border-t border-border">
              <Button
                size="sm"
                variant="ghost"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                <ChevronLeft className="h-3.5 w-3.5 mr-1" />
                Previous
              </Button>
              <span className="text-xs text-muted-foreground">
                Page {page + 1} of {totalPages}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={page >= totalPages - 1}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
                <ChevronRight className="h-3.5 w-3.5 ml-1" />
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
