import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, Workflow } from "lucide-react";
import type { Agent, HeartbeatRun } from "@paperclipai/shared";
import { HEARTBEAT_INVOCATION_SOURCES, HEARTBEAT_RUN_STATUSES } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { formatDateTime, relativeTime, cn } from "../lib/utils";
import { useNavigate } from "@/lib/router";
import { nav, orchestrationInjectionPage } from "../lib/i18n";
import { runDetailPath } from "../lib/run-routes";

function runSummaryLine(run: HeartbeatRun) {
  if (run.resultJson && typeof run.resultJson === "object") {
    const r = run.resultJson as Record<string, unknown>;
    const s = String(r.summary ?? r.result ?? "").trim();
    if (s.length > 0) return s.length > 80 ? `${s.slice(0, 80)}…` : s;
  }
  const err = run.error?.trim();
  return err ? (err.length > 80 ? `${err.slice(0, 80)}…` : err) : "";
}

function runStatusLabel(status: string) {
  const map = orchestrationInjectionPage.runStatusDisplay as Record<string, string>;
  return map[status] ?? status;
}

export function OrchestrationInjection() {
  const navigate = useNavigate();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(20);
  const [filterAgentId, setFilterAgentId] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [filterInvocationSource, setFilterInvocationSource] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: nav.work }, { label: nav.orchestrationInjection }]);
  }, [setBreadcrumbs]);

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const runsPagedQuery = useQuery({
    queryKey: [
      "runs-paged",
      selectedCompanyId,
      pageIndex,
      pageSize,
      filterAgentId,
      filterStatus,
      filterInvocationSource,
    ],
    queryFn: () =>
      heartbeatsApi.listPaged(selectedCompanyId!, {
        offset: pageIndex * pageSize,
        limit: pageSize,
        agentId: filterAgentId || undefined,
        status: filterStatus ? [filterStatus] : undefined,
        invocationSource: filterInvocationSource || undefined,
      }),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: 30_000,
  });

  const pageRuns = runsPagedQuery.data?.runs ?? [];
  const totalRuns = runsPagedQuery.data?.total ?? 0;

  useEffect(() => {
    setPageIndex(0);
  }, [filterAgentId, filterStatus, filterInvocationSource, pageSize]);

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(totalRuns / pageSize));
    const maxIndex = Math.max(0, totalPages - 1);
    if (pageIndex > maxIndex) setPageIndex(maxIndex);
  }, [totalRuns, pageSize, pageIndex]);

  const agentsById = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agentsQuery.data ?? []) map.set(agent.id, agent);
    return map;
  }, [agentsQuery.data]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Workflow} message={orchestrationInjectionPage.selectCompany} />;
  }

  if (runsPagedQuery.isLoading || agentsQuery.isLoading) {
    return <PageSkeleton variant="list" />;
  }

  if (runsPagedQuery.error || agentsQuery.error) {
    const error = runsPagedQuery.error ?? agentsQuery.error;
    return (
      <div className="text-sm text-destructive">
        {error instanceof Error ? error.message : orchestrationInjectionPage.failedToLoad}
      </div>
    );
  }

  const hasFilters = Boolean(filterAgentId || filterStatus || filterInvocationSource);
  const totalPages = Math.max(1, Math.ceil(totalRuns / pageSize));

  const openRun = (runId: string) => {
    navigate(runDetailPath(runId));
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Workflow className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-lg font-semibold">{orchestrationInjectionPage.title}</h1>
          </div>
          <p className="text-sm text-muted-foreground">{orchestrationInjectionPage.subtitle}</p>
        </div>
      </div>

      {totalRuns === 0 && !runsPagedQuery.isLoading ? (
        <EmptyState
          icon={Activity}
          message={hasFilters ? orchestrationInjectionPage.emptyFiltered : orchestrationInjectionPage.empty}
        />
      ) : (
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-muted/10 p-3">
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">{orchestrationInjectionPage.filterAgent}</div>
              <Select
                value={filterAgentId || "__all__"}
                onValueChange={(v) => setFilterAgentId(v === "__all__" ? "" : v)}
              >
                <SelectTrigger className="h-9 w-[min(100vw-2rem,220px)] sm:w-[220px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">{orchestrationInjectionPage.filterAll}</SelectItem>
                  {(agentsQuery.data ?? []).map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">{orchestrationInjectionPage.filterStatus}</div>
              <Select value={filterStatus || "__all__"} onValueChange={(v) => setFilterStatus(v === "__all__" ? "" : v)}>
                <SelectTrigger className="h-9 w-[min(100vw-2rem,160px)] sm:w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">{orchestrationInjectionPage.filterAll}</SelectItem>
                  {HEARTBEAT_RUN_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {runStatusLabel(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">{orchestrationInjectionPage.filterSource}</div>
              <Select
                value={filterInvocationSource || "__all__"}
                onValueChange={(v) => setFilterInvocationSource(v === "__all__" ? "" : v)}
              >
                <SelectTrigger className="h-9 w-[min(100vw-2rem,160px)] sm:w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">{orchestrationInjectionPage.filterAll}</SelectItem>
                  {HEARTBEAT_INVOCATION_SOURCES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {orchestrationInjectionPage.wakeAttributionSourceLabels[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">{orchestrationInjectionPage.pageSizeLabel}</div>
              <Select value={String(pageSize)} onValueChange={(v) => setPageSize(Number(v))}>
                <SelectTrigger className="h-9 w-[100px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[10, 20, 50].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {orchestrationInjectionPage.pageSizeOption(n)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border border-border">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
              <div className="text-sm font-medium">{orchestrationInjectionPage.runTableTitle}</div>
              <div className="text-xs text-muted-foreground tabular-nums">
                {orchestrationInjectionPage.paginationTotal(totalRuns)}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[56rem] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30 text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">{orchestrationInjectionPage.runTableColId}</th>
                    <th className="px-3 py-2 font-medium">{orchestrationInjectionPage.runTableColAgent}</th>
                    <th className="px-3 py-2 font-medium">{orchestrationInjectionPage.runTableColStatus}</th>
                    <th className="px-3 py-2 font-medium">{orchestrationInjectionPage.runTableColSource}</th>
                    <th className="px-3 py-2 font-medium">{orchestrationInjectionPage.runTableColCreated}</th>
                    <th className="px-3 py-2 font-medium">{orchestrationInjectionPage.runTableColSummary}</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRuns.map((run) => {
                    const agent = agentsById.get(run.agentId);
                    return (
                      <tr
                        key={run.id}
                        className={cn("cursor-pointer border-b border-border transition-colors hover:bg-accent/30")}
                        onClick={() => openRun(run.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            openRun(run.id);
                          }
                        }}
                        tabIndex={0}
                        role="link"
                      >
                        <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{run.id.slice(0, 8)}…</td>
                        <td className="max-w-[10rem] truncate px-3 py-2">{agent?.name ?? run.agentId}</td>
                        <td className="px-3 py-2">
                          <Badge
                            variant={
                              run.status === "succeeded"
                                ? "secondary"
                                : run.status === "failed"
                                  ? "destructive"
                                  : "outline"
                            }
                            className="text-[10px]"
                          >
                            {runStatusLabel(run.status)}
                          </Badge>
                        </td>
                        <td className="px-3 py-2 text-xs">
                          {orchestrationInjectionPage.wakeAttributionSourceLabels[
                            run.invocationSource as keyof typeof orchestrationInjectionPage.wakeAttributionSourceLabels
                          ] ?? run.invocationSource}
                        </td>
                        <td
                          className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground"
                          title={formatDateTime(run.createdAt)}
                        >
                          {relativeTime(run.createdAt)}
                        </td>
                        <td className="max-w-[18rem] truncate px-3 py-2 text-xs text-muted-foreground">
                          {runSummaryLine(run)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2">
              <div className="text-xs text-muted-foreground tabular-nums">
                {orchestrationInjectionPage.paginationPage(pageIndex + 1, totalPages)}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pageIndex <= 0 || runsPagedQuery.isFetching}
                  onClick={() => setPageIndex((p) => Math.max(0, p - 1))}
                >
                  {orchestrationInjectionPage.prevPage}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pageIndex >= totalPages - 1 || runsPagedQuery.isFetching}
                  onClick={() => setPageIndex((p) => p + 1)}
                >
                  {orchestrationInjectionPage.nextPage}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
