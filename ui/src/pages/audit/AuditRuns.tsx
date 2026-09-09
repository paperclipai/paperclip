import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { HeartbeatRun, RoutineRunSummary, RunRecallResponse } from "@paperclipai/shared";
import { Activity, CircleDotDashed, Download, Search } from "lucide-react";
import { agentsApi } from "@/api/agents";
import { heartbeatsApi } from "@/api/heartbeats";
import { routinesApi } from "@/api/routines";
import { EmptyState } from "@/components/EmptyState";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { auditSectionHref, runAuditHref } from "./audit-navigation";

const ALL = "__all";
const RUN_LIMIT = 200;
const RECALL_DEBOUNCE_MS = 300;

function RunRecallSearchInput({
  value,
  onDebouncedChange,
}: {
  value: string;
  onDebouncedChange: (search: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const committedRef = useRef(value);
  useEffect(() => {
    setDraft(value);
    committedRef.current = value;
  }, [value]);
  useEffect(() => {
    if (draft === committedRef.current) return;
    const timeoutId = window.setTimeout(() => {
      committedRef.current = draft;
      onDebouncedChange(draft);
    }, RECALL_DEBOUNCE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [draft, onDebouncedChange]);
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Search runs and activity…"
        aria-label="Search runs and activity"
        className="w-56 pl-8"
      />
    </div>
  );
}

function recallMatchedFieldLabel(field: string): string {
  switch (field) {
    case "errorCode":
      return "error code";
    case "resultSummary":
      return "result summary";
    case "resultResult":
      return "result";
    case "resultMessage":
      return "result message";
    case "resultError":
      return "result error";
    case "issue":
      return "linked issue";
    default:
      return readableSource(field);
  }
}

function downloadRecallJson(companyId: string, data: RunRecallResponse) {  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `run-recall-${companyId}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

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
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function readableSource(source: string) {
  return source.replaceAll("_", " ");
}

function routineRunTitle(run: RoutineRunSummary) {
  return run.linkedIssue?.title ?? run.trigger?.label ?? "Routine run";
}

function RoutineScopedRuns({
  runs,
  isLoading,
  error,
  onRetry,
}: {
  runs: RoutineRunSummary[];
  isLoading: boolean;
  error: Error | null;
  onRetry: () => void;
}) {
  if (isLoading) {
    return (
      <div className="border-y border-border py-14 text-center text-sm text-muted-foreground">
        Loading routine runs…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 border-y border-border py-14 text-center">
        <p className="text-sm text-muted-foreground">{error.message}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>Try again</Button>
      </div>
    );
  }

  if (runs.length === 0) {
    return <EmptyState icon={Activity} message="No routine runs yet." />;
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Routine runs</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Executions created by this routine, newest first.
        </p>
      </div>
      <ul className="divide-y divide-border border-y border-border" aria-label="Routine runs">
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
      <p className="text-xs text-muted-foreground">Showing the {RUN_LIMIT} most recent routine runs.</p>
    </div>
  );
}

function RunRecallResults({
  query,
  isLoading,
  error,
  onRetry,
  onDownload,
  agentNameOf,
}: {
  query: RunRecallResponse | undefined;
  isLoading: boolean;
  error: Error | null;
  onRetry: () => void;
  onDownload: () => void;
  agentNameOf: (agentId: string) => string | null;
}) {
  if (isLoading) {
    return (
      <div className="border-y border-border py-14 text-center text-sm text-muted-foreground">
        Searching runs and activity…
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 border-y border-border py-14 text-center">
        <p className="text-sm text-muted-foreground">{error.message}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }
  if (!query || (query.runs.length === 0 && query.activity.length === 0)) {
    return (
      <EmptyState
        icon={CircleDotDashed}
        message={query ? `No runs or activity match "${query.query}".` : "Type at least 2 characters to search."}
      />
    );
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {query.runs.length} {query.runs.length === 1 ? "run" : "runs"} · {query.activity.length}{" "}
          {query.activity.length === 1 ? "activity entry" : "activity entries"} matching “{query.query}”
        </p>
        <Button variant="outline" size="sm" onClick={onDownload}>
          <Download className="h-3.5 w-3.5" />
          JSON
        </Button>
      </div>
      {query.runs.length > 0 ? (
        <ul className="divide-y divide-border border-y border-border" aria-label="Matching runs">
          {query.runs.map((match) => (
            <li key={match.runId}>
              <Link
                to={`/agents/${match.agentId}/runs/${match.runId}`}
                className="flex flex-col gap-2 px-1 py-3 text-inherit no-underline transition-colors hover:bg-muted/50 sm:flex-row sm:items-start sm:justify-between sm:px-3"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">
                      {agentNameOf(match.agentId) ?? "Unknown agent"}
                    </span>
                    <span className="font-mono text-(length:--text-micro) text-muted-foreground">
                      {match.runId.slice(0, 8)}
                    </span>
                    <StatusBadge status={match.status} />
                    <span className="text-(length:--text-micro) text-muted-foreground">
                      matched {recallMatchedFieldLabel(match.matchedField)}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{match.snippet}</p>
                  {match.issueIdentifier || match.issueTitle ? (
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {match.issueIdentifier ? `${match.issueIdentifier} ` : ""}
                      {match.issueTitle ?? ""}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground sm:justify-end">
                  <time dateTime={new Date(match.createdAt).toISOString()}>
                    {relativeTime(match.createdAt)}
                  </time>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {query.activity.length > 0 ? (
        <div>
          <h3 className="mb-1 text-sm font-medium text-foreground">Matching activity</h3>
          <ul className="divide-y divide-border border-y border-border" aria-label="Matching activity">
            {query.activity.map((entry) => {
              const target = entry.runId
                ? runAuditHref(entry.runId, entry.agentId)
                : entry.entityType === "issue"
                  ? `/issues/${entry.entityId}`
                  : entry.entityType === "routine"
                    ? auditSectionHref("activity", { entityType: "routine", entityId: entry.entityId })
                    : null;
              const row = (
                <>
                  <span className="font-mono text-(length:--text-micro) text-foreground">
                    {entry.action}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {entry.entityType} {entry.entityId.slice(0, 8)}
                  </span>
                  <time
                    className="ml-auto shrink-0 text-xs text-muted-foreground"
                    dateTime={new Date(entry.createdAt).toISOString()}
                  >
                    {relativeTime(entry.createdAt)}
                  </time>
                </>
              );
              return (
                <li key={entry.id}>
                  {target ? (
                    <Link
                      to={target}
                      className="flex items-center gap-2 px-1 py-2 text-inherit no-underline transition-colors hover:bg-muted/50 sm:px-3"
                    >
                      {row}
                    </Link>
                  ) : (
                    <div className="flex items-center gap-2 px-1 py-2 sm:px-3">{row}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function AuditRuns({ companyId, routineId }: { companyId: string; routineId?: string }) {  const [searchParams, setSearchParams] = useSearchParams();
  const agentId = searchParams.get("agentId") ?? ALL;
  const status = searchParams.get("runStatus") ?? ALL;
  const q = searchParams.get("q") ?? "";
  const searching = q.trim().length >= 2;
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
    refetchInterval: searching ? false : 15_000,
    enabled: !routineId,
  });
  const routineRuns = useQuery({
    queryKey: [...queryKeys.routines.runs(routineId ?? ""), "audit"],
    queryFn: () => routinesApi.listRuns(routineId!, RUN_LIMIT),
    enabled: Boolean(routineId),
    refetchInterval: 15_000,
  });
  const recall = useQuery({
    queryKey: queryKeys.audit.runRecall(companyId, {
      q: q.trim(),
      agentId: agentId === ALL ? null : agentId,
      status: status === ALL ? null : status,
    }),
    queryFn: () =>
      heartbeatsApi.searchRuns(companyId, {
        q: q.trim(),
        agentId: agentId === ALL ? undefined : agentId,
        status: status === ALL ? undefined : status,
      }),
    enabled: !routineId && searching,
  });
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

  const updateFilter = (key: "agentId" | "runStatus" | "q", value: string) => {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value === ALL || value.trim().length === 0) next.delete(key);
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
        next.delete("q");
        return next;
      },
      { replace: true },
    );
  };

  if (routineId) {
    return (
      <RoutineScopedRuns
        runs={routineRuns.data ?? []}
        isLoading={routineRuns.isLoading}
        error={routineRuns.error instanceof Error ? routineRuns.error : null}
        onRetry={() => void routineRuns.refetch()}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Runs</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Recent agent executions across the organization. Open a run to inspect its transcript,
          output, and task context.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 border-y border-border py-3">
        <label className="grid gap-1 text-(length:--text-micro) font-medium text-muted-foreground">
          <span>Agent</span>
          <Select value={agentId} onValueChange={(value) => updateFilter("agentId", value)}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="All agents" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All agents</SelectItem>
              {(agents.data ?? []).map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="grid gap-1 text-(length:--text-micro) font-medium text-muted-foreground">
          <span>Status</span>
          <Select value={status} onValueChange={(value) => updateFilter("runStatus", value)}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All statuses</SelectItem>
              {statuses.map((value) => (
                <SelectItem key={value} value={value}>
                  {readableSource(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        {agentId !== ALL || status !== ALL || q !== "" ? (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        ) : null}
        <div className="ml-auto">
          <RunRecallSearchInput value={q} onDebouncedChange={(value) => updateFilter("q", value)} />
        </div>
      </div>

      {searching ? (
        <RunRecallResults
          query={recall.data}
          isLoading={recall.isLoading}
          error={recall.error instanceof Error ? recall.error : null}
          onRetry={() => void recall.refetch()}
          onDownload={() => {
            if (recall.data) downloadRecallJson(companyId, recall.data);
          }}
          agentNameOf={(agentId) => agentById.get(agentId)?.name ?? null}
        />
      ) : null}

      {!searching && runs.isLoading ? (
        <div className="border-y border-border py-14 text-center text-sm text-muted-foreground">
          Loading runs…
        </div>
      ) : !searching && runs.error ? (
        <div className="flex flex-col items-center gap-3 border-y border-border py-14 text-center">
          <p className="text-sm text-muted-foreground">
            {runs.error instanceof Error ? runs.error.message : "Failed to load runs."}
          </p>
          <Button variant="outline" size="sm" onClick={() => runs.refetch()}>
            Try again
          </Button>
        </div>
      ) : !searching && visibleRuns.length === 0 ? (
        <EmptyState
          icon={agentId !== ALL || status !== ALL ? CircleDotDashed : Activity}
          message={agentId !== ALL || status !== ALL ? "No runs match these filters." : "No runs yet."}
        />
      ) : !searching ? (
        <ul className="divide-y divide-border border-y border-border" aria-label="Recent runs">
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
                        {agent?.name ?? "Unknown agent"}
                      </span>
                      <span className="font-mono text-(length:--text-micro) text-muted-foreground">
                        {run.id.slice(0, 8)}
                      </span>
                      <StatusBadge status={run.status} />
                    </div>
                    <p className="mt-1 truncate text-sm text-muted-foreground">
                      {summary ?? `${readableSource(run.invocationSource)} run`}
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
      ) : null}

      {!searching ? (
        <p className="text-xs text-muted-foreground">Showing the {RUN_LIMIT} most recent runs.</p>
      ) : null}
    </div>
  );
}
