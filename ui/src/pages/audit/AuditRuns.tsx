import { t as finalPagesT } from "@/i18n";
import { t as translateAgentPage, useTranslation } from "@/i18n";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { HeartbeatRun, RoutineRunSummary } from "@paperclipai/shared";
import { Activity, CircleDotDashed } from "lucide-react";
import { agentsApi } from "@/api/agents";
import { heartbeatsApi } from "@/api/heartbeats";
import { routinesApi } from "@/api/routines";
import { EmptyState } from "@/components/EmptyState";
import { QueryErrorState, useQueryView, type QueryViewState } from "@/components/QueryView";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { queryKeys } from "@/lib/queryKeys";
import { Link, useSearchParams } from "@/lib/router";
import { relativeTime } from "@/lib/utils";

const ALL = "__all";
const RUN_LIMIT = 200;

function runSummary(run: HeartbeatRun) {
  const result = run.resultJson as { summary?: unknown; result?: unknown } | null;
  const value = result?.summary ?? result?.result ?? run.error;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function runDuration(run: HeartbeatRun) {
  const start = run.startedAt ? new Date(run.startedAt).getTime() : null;
  const end = run.finishedAt ? new Date(run.finishedAt).getTime() : null;
  if (start == null || end == null || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return finalPagesT("final-pages:value_s_47c4d1", { value: seconds });
  const minutes = Math.floor(seconds / 60);
  return finalPagesT("final-pages:first_m_second_s_b97502", { first: minutes, second: seconds % 60 });
}

function readableSource(source: string) {
  return source.replaceAll("_", " ");
}

function routineRunTitle(run: RoutineRunSummary) {
  return run.linkedIssue?.title ?? run.trigger?.label ?? translateAgentPage("agents:routine_run");
}

function RoutineScopedRuns({
  runs,
  view,
}: {
  runs: RoutineRunSummary[];
  view: QueryViewState<RoutineRunSummary[]>;
}) {
  const { t: translateAgentPage } = useTranslation("agents");
  // A loaded list stays on screen through a failed refetch; an outage before
  // the first load reads as loading, and only a real failure shows copy.
  if (view.kind === "loading" || view.kind === "reconnecting") {
    return (
      <div className="border-y border-border py-14 text-center text-sm text-muted-foreground">{translateAgentPage("agents:loading_routine_runs")}</div>
    );
  }

  if (view.kind === "error") {
    return (
      <QueryErrorState
        error={view.error}
        action={translateAgentPage("agents:load_routine_runs")}
        onRetry={view.retry}
        retrying={view.isFetching}
      />
    );
  }

  if (runs.length === 0) {
    return <EmptyState icon={Activity} message={translateAgentPage("agents:no_routine_runs_yet")} />;
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{translateAgentPage("agents:routine_runs")}</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{translateAgentPage("agents:executions_created_by_this_routine_newest_first")}</p>
      </div>
      <ul className="divide-y divide-border border-y border-border" aria-label={translateAgentPage("agents:routine_runs")}>
        {runs.map((run) => {
          const content = (
            <>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">{routineRunTitle(run)}</span>
                  <StatusBadge status={run.status} />
                </div>
                <p className="mt-1 truncate text-sm text-muted-foreground">
                  {run.trigger?.label ?? readableSource(run.source)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground sm:justify-end">
                <span className="capitalize">{readableSource(run.source)}</span>
                <time dateTime={new Date(run.triggeredAt).toISOString()}>
                  {relativeTime(run.triggeredAt)}
                </time>
              </div>
            </>
          );
          const rowClassName = "flex flex-col gap-2 px-1 py-3 text-inherit no-underline transition-colors hover:bg-muted/50 sm:flex-row sm:items-start sm:justify-between sm:px-3";
          return (
            <li key={run.id}>
              {run.linkedIssue ? (
                <Link to={`/issues/${run.linkedIssue.identifier ?? run.linkedIssue.id}`} className={rowClassName}>
                  {content}
                </Link>
              ) : (
                <div className={rowClassName}>{content}</div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground">{translateAgentPage("agents:showing_the")}{" "}{RUN_LIMIT}{" "}{translateAgentPage("agents:most_recent_routine_runs")}</p>
    </div>
  );
}

export function AuditRuns({
  companyId,
  routineId,
  lockedAgentId,
  hideHeader = false,
}: {
  companyId: string;
  routineId?: string;
  /** Pin the list to one agent and hide the agent filter (the agent page's Runs). */
  lockedAgentId?: string;
  hideHeader?: boolean;
}) {
  const { t: translateAgentPage } = useTranslation("agents");
  const [searchParams, setSearchParams] = useSearchParams();
  const agentId = lockedAgentId ?? searchParams.get("agentId") ?? ALL;
  const status = searchParams.get("runStatus") ?? ALL;
  const agents = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !routineId,
  });
  const runs = useQuery({
    queryKey: queryKeys.audit.runs(companyId, agentId === ALL ? null : agentId),
    queryFn: () =>
      heartbeatsApi.list(companyId, agentId === ALL ? undefined : agentId, RUN_LIMIT, {
        summary: true,
      }),
    refetchInterval: 15_000,
    enabled: !routineId,
  });
  const routineRuns = useQuery({
    queryKey: [...queryKeys.routines.runs(routineId ?? ""), "audit"],
    queryFn: () => routinesApi.listRuns(routineId!, RUN_LIMIT),
    enabled: Boolean(routineId),
    refetchInterval: 15_000,
  });
  const runsView = useQueryView(runs);
  const routineRunsView = useQueryView(routineRuns);
  const agentById = useMemo(
    () => new Map((agents.data ?? []).map((agent) => [agent.id, agent])),
    [agents.data],
  );
  const statuses = useMemo(
    () => Array.from(new Set((runs.data ?? []).map((run) => run.status))).sort(),
    [runs.data],
  );
  const visibleRuns = useMemo(
    () => (runs.data ?? []).filter((run) => status === ALL || run.status === status),
    [runs.data, status],
  );

  const updateFilter = (key: "agentId" | "runStatus", value: string) => {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value === ALL) next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );
  };

  const clearFilters = () => {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("agentId");
        next.delete("runStatus");
        return next;
      },
      { replace: true },
    );
  };

  if (routineId) {
    return (
      <RoutineScopedRuns
        runs={routineRuns.data ?? []}
        view={routineRunsView}
      />
    );
  }

  return (
    <div className="space-y-4">
      {hideHeader ? null : (
        <div>
          <h2 className="text-lg font-semibold text-foreground">{translateAgentPage("agents:runs")}</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{translateAgentPage("agents:recent_agent_executions_across_the_organization_open_a")}</p>
        </div>
      )}

      <div data-canonical-toolbar="audit-runs" role="toolbar" aria-label="Audit filters" className="flex flex-wrap items-end gap-3 border-y border-border py-3">
        {lockedAgentId ? null : <label className="grid gap-1 text-(length:--text-micro) font-medium text-muted-foreground">
          <span>{translateAgentPage("agents:agent_5ce2e6")}</span>
          <Select value={agentId} onValueChange={(value) => updateFilter("agentId", value)}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder={translateAgentPage("agents:all_agents")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{translateAgentPage("agents:all_agents")}</SelectItem>
              {(agents.data ?? []).map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>}
        <label className="grid gap-1 text-(length:--text-micro) font-medium text-muted-foreground">
          <span>{translateAgentPage("agents:status")}</span>
          <Select value={status} onValueChange={(value) => updateFilter("runStatus", value)}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder={translateAgentPage("agents:all_statuses")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{translateAgentPage("agents:all_statuses")}</SelectItem>
              {statuses.map((value) => (
                <SelectItem key={value} value={value}>
                  {readableSource(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        {(!lockedAgentId && agentId !== ALL) || status !== ALL ? (
          <Button variant="ghost" size="sm" onClick={clearFilters}>{translateAgentPage("agents:clear_filters")}</Button>
        ) : null}
      </div>

      {runsView.kind === "loading" || runsView.kind === "reconnecting" ? (
        <div className="border-y border-border py-14 text-center text-sm text-muted-foreground">{translateAgentPage("agents:loading_runs")}</div>
      ) : runsView.kind === "error" ? (
        <QueryErrorState
          error={runsView.error}
          action={translateAgentPage("agents:load_runs")}
          onRetry={runsView.retry}
          retrying={runsView.isFetching}
        />
      ) : visibleRuns.length === 0 ? (
        <EmptyState
          icon={agentId !== ALL || status !== ALL ? CircleDotDashed : Activity}
          message={agentId !== ALL || status !== ALL ? translateAgentPage("agents:no_runs_match_these_filters") : translateAgentPage("agents:no_runs_yet")}
        />
      ) : (
        <ul className="divide-y divide-border border-y border-border" aria-label={translateAgentPage("agents:recent_runs")}>
          {visibleRuns.map((run) => {
            const agent = agentById.get(run.agentId);
            const summary = runSummary(run);
            const duration = runDuration(run);
            return (
              <li key={run.id}>
                <Link
                  to={`/agents/${run.agentId}/runs/${run.id}`}
                  className="flex flex-col gap-2 px-1 py-3 text-inherit no-underline transition-colors hover:bg-muted/50 sm:flex-row sm:items-start sm:justify-between sm:px-3"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">
                        {agent?.name ?? translateAgentPage("agents:unknown_agent")}
                      </span>
                      <span className="font-mono text-(length:--text-micro) text-muted-foreground">
                        {run.id.slice(0, 8)}
                      </span>
                      <StatusBadge status={run.status} />
                    </div>
                    <p className="mt-1 truncate text-sm text-muted-foreground">
                      {summary ?? translateAgentPage("agents:run_3acc0b", { value1: readableSource(run.invocationSource) })}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground sm:justify-end">
                    <span className="capitalize">{readableSource(run.invocationSource)}</span>
                    {duration ? <span>{duration}</span> : null}
                    <time dateTime={new Date(run.createdAt).toISOString()}>
                      {relativeTime(run.createdAt)}
                    </time>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-xs text-muted-foreground">{translateAgentPage("agents:showing_the")}{" "}{RUN_LIMIT}{" "}{translateAgentPage("agents:most_recent_runs")}</p>
    </div>
  );
}
