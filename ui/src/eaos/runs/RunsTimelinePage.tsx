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

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity as ActivityIcon, History } from "lucide-react";
import { activityApi } from "@/api/activity";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { EaosPageHeader } from "../EaosPageHeader";
import {
  EaosViewControls,
  eaosMatchesFilter,
  type EaosViewMode,
} from "../EaosViewControls";
import { redactSecretLikeText } from "../secret-redact";
import { useEaosViewerRole } from "../useEaosViewerRole";
import { humanizeActivityAction, humanizeActorType } from "./activity-labels";
import { AgentAvatar } from "../agents/AgentAvatar";
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
  const { selectedCompanyId } = useCompany();
  const { isOperator } = useEaosViewerRole();
  const [viewMode, setViewMode] = useState<EaosViewMode>("cards");
  const [filter, setFilter] = useState<string>("");

  const activityQuery = useQuery({
    queryKey: selectedCompanyId
      ? [...queryKeys.activity(selectedCompanyId), { limit: RUNS_PAGE_LIMIT }, "eaos-runs"]
      : ["activity", "__no-company__", "eaos-runs"],
    queryFn: () => activityApi.list(selectedCompanyId!, { limit: RUNS_PAGE_LIMIT }),
    enabled: Boolean(selectedCompanyId),
  });

  const rows = useMemo<RunTimelineRow[]>(() => {
    const collapsed = collapseEventsToRuns(activityQuery.data ?? []);
    if (!filter) return collapsed;
    return collapsed.filter((row) =>
      eaosMatchesFilter(
        `${row.issueTitle ?? ""} ${row.issueIdentifier ?? ""} ${row.latestAction}`,
        filter,
      ),
    );
  }, [activityQuery.data, filter]);
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
      className="-mx-4 -my-5 flex min-h-0 flex-1 flex-col sm:-mx-6 lg:-mx-8"
      data-testid="eaos-runs-page"
      data-eaos-data-connected={dataConnected ? "true" : "false"}
    >
      <EaosPageHeader title="Runs" testId="eaos-runs-page-header" />
      <h1 id="eaos-runs-title" className="sr-only" data-testid="eaos-runs-title">
        Runs
      </h1>

      <div className="flex min-h-0 flex-1 flex-col gap-5 px-4 py-4 sm:px-6 lg:px-8">
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
          <EaosViewControls
            mode={viewMode}
            onModeChange={setViewMode}
            filter={filter}
            onFilterChange={setFilter}
            filterPlaceholder="Filter runs…"
            testIdPrefix="eaos-runs"
          />
          {rows.length === 0 ? (
            <FilteredEmptyState filter={filter} />
          ) : (
            <RunsTable
              rows={rows}
              referenceNow={referenceNow}
              isOperator={isOperator}
              viewMode={viewMode}
            />
          )}
        </>
      )}
      </div>
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
      Loading runs…
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
        Refresh to try again.
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
      No runs yet. Runs show up here when agents start working.
    </div>
  );
}

function FilteredEmptyState({ filter }: { filter: string }) {
  return (
    <div
      role="status"
      className="rounded-md border border-dashed border-border bg-card p-3 text-xs text-muted-foreground"
      data-testid="eaos-runs-filter-empty"
    >
      {filter
        ? `No runs match “${filter.slice(0, 40)}”.`
        : "No runs match the current filter."}
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

function RunsTable({
  rows,
  referenceNow,
  isOperator,
  viewMode,
}: {
  rows: readonly RunTimelineRow[];
  referenceNow: Date;
  isOperator: boolean;
  viewMode: EaosViewMode;
}) {
  return (
    <section
      aria-label="Recent runs"
      className="flex flex-col gap-2"
      data-testid="eaos-runs-table"
    >
      <header className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-foreground">
          Recent runs{" "}
          <span className="text-xs font-normal text-muted-foreground">({rows.length})</span>
        </h2>
      </header>
      <ul
        className={
          viewMode === "list"
            ? "flex flex-col gap-1.5"
            : "grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3"
        }
        data-testid="eaos-runs-rows"
        data-eaos-view-mode={viewMode}
      >
        {rows.map((row) => (
          <RunRow
            key={row.runId}
            row={row}
            referenceNow={referenceNow}
            isOperator={isOperator}
            viewMode={viewMode}
          />
        ))}
      </ul>
    </section>
  );
}

function RunRow({
  row,
  referenceNow,
  isOperator,
  viewMode,
}: {
  row: RunTimelineRow;
  referenceNow: Date;
  isOperator: boolean;
  viewMode: EaosViewMode;
}) {
  const missionRef = row.issueIdentifier ?? row.issueId;
  const actorLabel = humanizeActorType(row.latestActorType);
  if (viewMode === "list") {
    return (
      <RunRowList
        row={row}
        missionRef={missionRef}
        actorLabel={actorLabel}
        referenceNow={referenceNow}
        isOperator={isOperator}
      />
    );
  }
  return (
    <li
      className="flex flex-col gap-2 rounded-md border border-border bg-card p-3"
      data-testid="eaos-runs-row"
      data-run-id={row.runId}
      data-eaos-view-mode="cards"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="rounded-full border border-border bg-background px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
          data-testid="eaos-runs-row-action"
        >
          {humanizeActivityAction(row.latestAction)}
        </span>
        {row.issueIdentifier ? (
          <span
            data-testid="eaos-runs-row-identifier"
            className="rounded-full border border-border bg-background px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
          >
            {row.issueIdentifier}
          </span>
        ) : null}
      </div>
      <div className="flex items-start gap-2.5">
        {row.latestActorType === "agent" && row.agentId ? (
          <AgentAvatar
            size="md"
            subject={{ kind: "agent", agentId: row.agentId, name: actorLabel, role: null }}
            testId="eaos-runs-row-actor-avatar"
          />
        ) : row.latestActorType === "user" ? (
          <AgentAvatar
            size="md"
            subject={{ kind: "user", userId: row.latestActorId, name: actorLabel }}
            testId="eaos-runs-row-actor-avatar"
          />
        ) : (
          <AgentAvatar
            size="md"
            subject={{ kind: "system" }}
            testId="eaos-runs-row-actor-avatar"
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="truncate text-sm font-medium text-foreground" data-testid="eaos-runs-row-title">
            {redactSecretLikeText(row.issueTitle ?? `Recent run`)}
          </p>
          <p className="text-xs text-muted-foreground" data-testid="eaos-runs-row-actor">
            {actorLabel}
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
            Open mission →
          </Link>
        ) : null}
        {isOperator && row.issueId ? (
          <Link
            to={`/issues/${row.issueId}`}
            className="font-medium text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            data-testid="eaos-runs-row-kernel-link"
          >
            Open in admin →
          </Link>
        ) : null}
      </div>
    </li>
  );
}

function RunRowList({
  row,
  missionRef,
  actorLabel,
  referenceNow,
  isOperator,
}: {
  row: RunTimelineRow;
  missionRef: string | null | undefined;
  actorLabel: string;
  referenceNow: Date;
  isOperator: boolean;
}) {
  return (
    <li
      className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2 text-[12px]"
      data-testid="eaos-runs-row"
      data-run-id={row.runId}
      data-eaos-view-mode="list"
    >
      {row.latestActorType === "agent" && row.agentId ? (
        <AgentAvatar
          size="sm"
          subject={{ kind: "agent", agentId: row.agentId, name: actorLabel, role: null }}
          testId="eaos-runs-row-actor-avatar"
        />
      ) : row.latestActorType === "user" ? (
        <AgentAvatar
          size="sm"
          subject={{ kind: "user", userId: row.latestActorId, name: actorLabel }}
          testId="eaos-runs-row-actor-avatar"
        />
      ) : (
        <AgentAvatar size="sm" subject={{ kind: "system" }} testId="eaos-runs-row-actor-avatar" />
      )}
      <div className="min-w-0 flex-1">
        <p
          className="truncate font-medium text-foreground"
          data-testid="eaos-runs-row-title"
        >
          {redactSecretLikeText(row.issueTitle ?? "Recent run")}
        </p>
        <p
          className="truncate text-[11px] text-muted-foreground"
          data-testid="eaos-runs-row-actor"
        >
          {actorLabel} · {humanizeActivityAction(row.latestAction)}
        </p>
      </div>
      <span
        className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline tabular-nums"
        data-testid="eaos-runs-row-last-event"
        title={`Last event ${relativeOrNever(row.lastActivityAt, referenceNow)}`}
      >
        {relativeOrNever(row.lastActivityAt, referenceNow)}
      </span>
      {missionRef ? (
        <Link
          to={`/eaos/missions/${missionRef}`}
          className="shrink-0 text-[11px] font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          data-testid="eaos-runs-row-mission-link"
        >
          <History aria-hidden="true" className="mr-1 inline h-3 w-3" />
          Mission
        </Link>
      ) : null}
      {isOperator && row.issueId ? (
        <Link
          to={`/issues/${row.issueId}`}
          className="shrink-0 text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          data-testid="eaos-runs-row-kernel-link"
        >
          Admin →
        </Link>
      ) : null}
    </li>
  );
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
