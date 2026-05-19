// LET-484 working-product slice — read-only `/eaos/runs` timeline.
//
// Source of truth: `activityApi.list(companyId, { limit })` (`GET
// /api/companies/:companyId/activity`). The page collapses run-scoped
// events into per-run rows and links each row into the mission detail
// (where the full transcript/tool-call/replay timeline lives) and into the
// kernel issue page (where the run can be opened or replayed).
//
// Truthful gaps captured here, per LET-187 strict semantic-trust:
//   - Timeline read · Data · BACKEND-BACKED once the live activity feed
//     resolves. No fake counts, no placeholder rows.
//   - Replay / transcript / tool-call deep view stays inside Mission
//     detail; this surface routes there rather than rendering a stub.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity as ActivityIcon, History } from "lucide-react";
import { activityApi } from "@/api/activity";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { EaosStateChip } from "../EaosStateChip";
import {
  NOT_CONNECTED_DATA_LABEL,
  NOT_CONNECTED_DATA_NOTE,
  NOT_CONNECTED_DATA_PREFIX,
  SHELL_POSTURE_LABEL,
  SHELL_POSTURE_PREFIX,
} from "../state-labels";
import { redactSecretLikeText } from "../secret-redact";
import {
  collapseEventsToRuns,
  summarizeRunTimeline,
  type RunTimelineRow,
  type RunTimelineCounts,
} from "./runs-timeline";

const RUNS_PAGE_LIMIT = 150;

export interface RunsTimelinePageProps {
  now?: Date;
}

export function RunsTimelinePage({ now }: RunsTimelinePageProps = {}) {
  const { selectedCompanyId, selectedCompany } = useCompany();

  const activityQuery = useQuery({
    queryKey: selectedCompanyId
      ? [...queryKeys.activity(selectedCompanyId), { limit: RUNS_PAGE_LIMIT }, "eaos-runs"]
      : ["activity", "__no-company__", "eaos-runs"],
    queryFn: () => activityApi.list(selectedCompanyId!, { limit: RUNS_PAGE_LIMIT }),
    enabled: Boolean(selectedCompanyId),
  });

  const rows = useMemo<RunTimelineRow[]>(
    () => collapseEventsToRuns(activityQuery.data ?? []),
    [activityQuery.data],
  );
  const counts = useMemo<RunTimelineCounts>(
    () => summarizeRunTimeline(activityQuery.data ?? []),
    [activityQuery.data],
  );

  const isLoading = Boolean(selectedCompanyId) && activityQuery.isLoading;
  const isError = Boolean(selectedCompanyId) && activityQuery.isError;
  const hasData = !isLoading && !isError && activityQuery.isSuccess;
  const dataConnected = hasData;
  const referenceNow = now ?? new Date();

  return (
    <section
      aria-labelledby="eaos-runs-title"
      className="flex flex-col gap-5"
      data-testid="eaos-runs-page"
      data-eaos-data-connected={dataConnected ? "true" : "false"}
    >
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2" data-testid="eaos-runs-posture">
          <EaosStateChip label={SHELL_POSTURE_LABEL} prefix={SHELL_POSTURE_PREFIX} />
          {dataConnected ? (
            <EaosStateChip
              label="BACKEND-BACKED"
              prefix="Timeline"
              title="Run timeline sourced from canonical activity events via /api/companies/:companyId/activity"
            />
          ) : (
            <EaosStateChip label={NOT_CONNECTED_DATA_LABEL} prefix={NOT_CONNECTED_DATA_PREFIX} />
          )}
          <EaosStateChip
            label="PREVIEW"
            prefix="Replay"
            title="Run transcript / tool-call / replay deep view lives inside Mission detail (/eaos/missions/:missionRef). This zone routes there rather than rendering a stub."
          />
          <span
            className="text-[11px] uppercase tracking-wide text-muted-foreground"
            data-testid="eaos-runs-posture-note"
          >
            {dataConnected
              ? `Live read · ${selectedCompany?.name ? redactSecretLikeText(selectedCompany.name) : "current company scope"}`
              : NOT_CONNECTED_DATA_NOTE}
          </span>
        </div>
        <div className="flex flex-col gap-1.5 sm:flex-row sm:items-end sm:justify-between sm:gap-3">
          <div className="flex flex-col gap-1">
            <h1
              id="eaos-runs-title"
              className="text-2xl font-semibold tracking-tight text-foreground"
              data-testid="eaos-runs-title"
            >
              Runs / Observability
            </h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Recent agent runs collapsed from the canonical activity feed for the current company
              scope. Each row links into the mission detail timeline (transcript, tool calls,
              replay) and the kernel issue view; this surface is read-only briefing only.
            </p>
          </div>
        </div>
      </header>

      {!selectedCompanyId ? (
        <NoCompanyState />
      ) : isLoading ? (
        <LoadingState />
      ) : isError ? (
        <ErrorState message={readErrorMessage(activityQuery.error)} />
      ) : rows.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <SummaryStrip counts={counts} referenceNow={referenceNow} />
          <RunsTable rows={rows} referenceNow={referenceNow} />
        </>
      )}
    </section>
  );
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Failed to load run timeline.";
}

function NoCompanyState() {
  return (
    <div
      role="status"
      className="rounded-md border border-dashed border-border bg-card p-4 text-sm text-muted-foreground"
      data-testid="eaos-runs-no-company"
    >
      Select a company scope from the top bar to load the run timeline. This surface reads
      activity for the currently selected company only.
    </div>
  );
}

function LoadingState() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground"
      data-testid="eaos-runs-loading"
    >
      Loading run timeline from the canonical activity feed…
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100"
      data-testid="eaos-runs-error"
    >
      <p className="font-medium">Could not load runs.</p>
      <p className="mt-1 text-xs">{redactSecretLikeText(message)}</p>
      <p className="mt-1 text-xs">
        Rows and counts are hidden because no backend-backed timeline is available. Retry by
        refreshing or use the Kernel/Admin activity log.
      </p>
    </div>
  );
}

function EmptyState() {
  return (
    <div
      role="status"
      className="rounded-md border border-dashed border-border bg-card p-4 text-sm text-muted-foreground"
      data-testid="eaos-runs-empty"
    >
      No runs are visible in the current company scope yet. When an agent wakes and starts a run
      it will appear here.
    </div>
  );
}

function SummaryStrip({
  counts,
  referenceNow,
}: {
  counts: RunTimelineCounts;
  referenceNow: Date;
}) {
  const items: Array<{ id: string; label: string; value: string }> = [
    { id: "runs", label: "Runs", value: counts.totalRuns.toString() },
    { id: "events", label: "Events", value: counts.totalEvents.toString() },
    { id: "agents", label: "Agents", value: counts.distinctAgents.toString() },
    { id: "issues", label: "Missions", value: counts.distinctIssues.toString() },
    {
      id: "last-event",
      label: "Last event",
      value: counts.lastEventAt ? relativeOrNever(counts.lastEventAt, referenceNow) : "—",
    },
  ];
  return (
    <dl
      data-testid="eaos-runs-summary"
      className="grid grid-cols-2 gap-2 rounded-md border border-border bg-card p-3 sm:grid-cols-3 lg:grid-cols-5"
    >
      {items.map((item) => (
        <div
          key={item.id}
          data-testid={`eaos-runs-summary-${item.id}`}
          className="flex flex-col gap-0.5"
        >
          <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{item.label}</dt>
          <dd className="text-lg font-semibold text-foreground tabular-nums">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function RunsTable({ rows, referenceNow }: { rows: readonly RunTimelineRow[]; referenceNow: Date }) {
  return (
    <section
      aria-label="Recent runs"
      className="flex flex-col gap-2"
      data-testid="eaos-runs-table"
    >
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">
          Recent runs{" "}
          <span className="text-xs font-normal text-muted-foreground">({rows.length})</span>
        </h2>
        <EaosStateChip
          label="BACKEND-BACKED"
          prefix="Rows"
          title="Each row collapses one canonical run's activity-event breadcrumbs from the live feed."
        />
      </header>
      <ul
        className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3"
        data-testid="eaos-runs-rows"
      >
        {rows.map((row) => (
          <RunRow key={row.runId} row={row} referenceNow={referenceNow} />
        ))}
      </ul>
    </section>
  );
}

function RunRow({ row, referenceNow }: { row: RunTimelineRow; referenceNow: Date }) {
  const missionRef = row.issueIdentifier ?? row.issueId;
  return (
    <li
      className="flex flex-col gap-2 rounded-md border border-border bg-card p-3"
      data-testid="eaos-runs-row"
      data-run-id={row.runId}
    >
      <div className="flex flex-wrap items-center gap-2">
        <EaosStateChip
          label="BACKEND-BACKED"
          prefix="Run"
          title="Row derived from canonical activity events. Run state is the latest event for this runId."
        />
        <span
          className="rounded-md border border-dashed border-border bg-background px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
          data-testid="eaos-runs-row-action"
        >
          {row.latestAction}
        </span>
        {row.issueIdentifier ? (
          <span
            data-testid="eaos-runs-row-identifier"
            className="rounded-md border border-dashed border-border bg-background px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
          >
            {row.issueIdentifier}
          </span>
        ) : null}
      </div>
      <div className="flex items-start gap-2">
        <ActivityIcon aria-hidden="true" className="mt-0.5 h-4 w-4 text-foreground" />
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="truncate text-sm font-medium text-foreground" data-testid="eaos-runs-row-title">
            {redactSecretLikeText(row.issueTitle ?? `Run ${shortRunId(row.runId)}`)}
          </p>
          <p className="text-xs text-muted-foreground" data-testid="eaos-runs-row-actor">
            {row.latestActorType}
            {row.agentId ? <> · agent {shortAgentId(row.agentId)}</> : null}
          </p>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
        <div className="flex flex-col" data-testid="eaos-runs-row-last-event">
          <dt className="uppercase tracking-wide">Last event</dt>
          <dd className="text-foreground">{relativeOrNever(row.lastActivityAt, referenceNow)}</dd>
        </div>
        <div className="flex flex-col" data-testid="eaos-runs-row-events">
          <dt className="uppercase tracking-wide">Events</dt>
          <dd className="text-foreground tabular-nums">{row.eventCount}</dd>
        </div>
      </dl>
      <div className="flex flex-wrap items-center gap-3 text-xs">
        {missionRef ? (
          <Link
            to={`/eaos/missions/${missionRef}`}
            className="font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            data-testid="eaos-runs-row-mission-link"
          >
            <History aria-hidden="true" className="mr-1 inline h-3 w-3" />
            Open mission detail →
          </Link>
        ) : null}
        {row.issueId ? (
          <Link
            to={`/issues/${row.issueId}`}
            className="font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            data-testid="eaos-runs-row-kernel-link"
          >
            Open in Kernel/Admin →
          </Link>
        ) : null}
      </div>
    </li>
  );
}

function shortRunId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function shortAgentId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function relativeOrNever(when: Date | null, now: Date): string {
  if (!when) return "—";
  const deltaMs = now.getTime() - when.getTime();
  if (deltaMs < 0) return "Just now";
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}
