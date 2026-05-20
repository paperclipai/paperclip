// LET-484 working-product slice — read-only `/eaos/projects` roadmap.
//
// Source of truth: `projectsApi.list(companyId)` + `goalsApi.list(companyId)`.
// The page wires the two reads together so each project row carries the
// linked goal titles, lead agent, target date, and workspace count without
// the operator having to context-switch. Action verbs (start workspace,
// archive, configure) stay inside the kernel project detail.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, Layers } from "lucide-react";
import { goalsApi } from "@/api/goals";
import { projectsApi } from "@/api/projects";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { EaosPageHeader } from "../EaosPageHeader";
import { EaosStateChip } from "../EaosStateChip";
import {
  EaosViewControls,
  eaosMatchesFilter,
  type EaosViewMode,
} from "../EaosViewControls";
import { redactSecretLikeText } from "../secret-redact";
import { useEaosViewerRole } from "../useEaosViewerRole";
import {
  groupRoadmap,
  summarizeRoadmap,
  type ProjectRoadmapBucket,
  type ProjectRoadmapCounts,
  type ProjectRoadmapRow,
} from "./projects-roadmap";

export interface ProjectsRoadmapPageProps {
  now?: Date;
}

export function ProjectsRoadmapPage({ now }: ProjectsRoadmapPageProps = {}) {
  const { selectedCompanyId } = useCompany();
  const { isOperator } = useEaosViewerRole();
  const [viewMode, setViewMode] = useState<EaosViewMode>("cards");
  const [filter, setFilter] = useState<string>("");

  const projectsQuery = useQuery({
    queryKey: selectedCompanyId
      ? [...queryKeys.projects.list(selectedCompanyId), "eaos-roadmap"]
      : ["projects", "__no-company__", "eaos-roadmap"],
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const goalsQuery = useQuery({
    queryKey: selectedCompanyId
      ? [...queryKeys.goals.list(selectedCompanyId), "eaos-roadmap"]
      : ["goals", "__no-company__", "eaos-roadmap"],
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const buckets = useMemo<readonly ProjectRoadmapBucket[]>(() => {
    const grouped = groupRoadmap(projectsQuery.data ?? [], goalsQuery.data ?? []);
    if (!filter) return grouped;
    return grouped.map((bucket) => ({
      ...bucket,
      rows: bucket.rows.filter((row) =>
        eaosMatchesFilter(`${row.name} ${row.description ?? ""}`, filter),
      ),
    }));
  }, [projectsQuery.data, goalsQuery.data, filter]);
  const counts = useMemo<ProjectRoadmapCounts>(
    () => summarizeRoadmap(projectsQuery.data ?? [], goalsQuery.data ?? []),
    [projectsQuery.data, goalsQuery.data],
  );

  const isLoading = Boolean(selectedCompanyId) && (projectsQuery.isLoading || goalsQuery.isLoading);
  const isError = Boolean(selectedCompanyId) && (projectsQuery.isError || goalsQuery.isError);
  const hasData =
    !isLoading && !isError && projectsQuery.isSuccess && goalsQuery.isSuccess;
  const dataConnected = hasData;
  const referenceNow = now ?? new Date();

  return (
    <section
      aria-labelledby="eaos-projects-title"
      className="-mx-4 -my-5 flex min-h-0 flex-1 flex-col sm:-mx-6 lg:-mx-8"
      data-testid="eaos-projects-page"
      data-eaos-data-connected={dataConnected ? "true" : "false"}
    >
      <EaosPageHeader title="Projects" testId="eaos-projects-page-header" />
      <h1 id="eaos-projects-title" className="sr-only" data-testid="eaos-projects-title">
        Projects
      </h1>

      <div className="flex min-h-0 flex-1 flex-col gap-5 px-4 py-4 sm:px-6 lg:px-8">
      {!selectedCompanyId ? (
        <NoCompanyState />
      ) : isLoading ? (
        <LoadingState />
      ) : isError ? (
        <ErrorState
          message={readErrorMessage(projectsQuery.error ?? goalsQuery.error)}
        />
      ) : (projectsQuery.data?.length ?? 0) === 0 ? (
        <EmptyState />
      ) : (
        <>
          <SummaryStrip counts={counts} />
          <EaosViewControls
            mode={viewMode}
            onModeChange={setViewMode}
            filter={filter}
            onFilterChange={setFilter}
            filterPlaceholder="Filter projects…"
            testIdPrefix="eaos-projects"
          />
          {buckets.map((bucket) => (
            <RoadmapBucketSection
              key={bucket.id}
              bucket={bucket}
              referenceNow={referenceNow}
              isOperator={isOperator}
              viewMode={viewMode}
              defaultEmpty={
                bucket.id === "in_progress"
                  ? "No projects in progress."
                  : bucket.id === "planned"
                    ? "No planned projects."
                    : bucket.id === "backlog"
                      ? "No backlog projects."
                      : bucket.id === "shipped"
                        ? "No shipped projects yet."
                        : "No stopped or archived projects."
              }
            />
          ))}
        </>
      )}
      </div>
    </section>
  );
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Failed to load projects + goals.";
}

function NoCompanyState() {
  return (
    <div
      role="status"
      className="rounded-md border border-dashed border-border bg-card p-4 text-sm text-muted-foreground"
      data-testid="eaos-projects-no-company"
    >
      Select a company scope from the top bar to load the projects roadmap.
    </div>
  );
}

function LoadingState() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground"
      data-testid="eaos-projects-loading"
    >
      Loading projects + goals from canonical records…
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100"
      data-testid="eaos-projects-error"
    >
      <p className="font-medium">Could not load projects.</p>
      <p className="mt-1 text-xs">{redactSecretLikeText(message)}</p>
      <p className="mt-1 text-xs">Refresh to try again.</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div
      role="status"
      className="rounded-md border border-dashed border-border bg-card p-4 text-sm text-muted-foreground"
      data-testid="eaos-projects-empty"
    >
      No projects yet.
    </div>
  );
}

function SummaryStrip({ counts }: { counts: ProjectRoadmapCounts }) {
  const items: Array<{ id: string; label: string; value: number }> = [
    { id: "total", label: "Total", value: counts.total },
    { id: "in-progress", label: "In progress", value: counts.inProgress },
    { id: "planned", label: "Planned", value: counts.planned },
    { id: "backlog", label: "Backlog", value: counts.backlog },
    { id: "shipped", label: "Shipped", value: counts.completed },
    { id: "stopped", label: "Stopped", value: counts.cancelled + counts.archived },
    { id: "active-goals", label: "Active goals", value: counts.activeGoals },
  ];
  return (
    <dl
      data-testid="eaos-projects-summary"
      className="grid grid-cols-2 gap-2 rounded-md border border-border bg-card p-3 sm:grid-cols-3 lg:grid-cols-7"
    >
      {items.map((item) => (
        <div
          key={item.id}
          data-testid={`eaos-projects-summary-${item.id}`}
          className="flex flex-col gap-0.5"
        >
          <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{item.label}</dt>
          <dd className="text-lg font-semibold text-foreground tabular-nums">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function RoadmapBucketSection({
  bucket,
  referenceNow,
  defaultEmpty,
  isOperator,
  viewMode,
}: {
  bucket: ProjectRoadmapBucket;
  referenceNow: Date;
  defaultEmpty: string;
  isOperator: boolean;
  viewMode: EaosViewMode;
}) {
  return (
    <section
      aria-label={bucket.label}
      className="flex flex-col gap-2"
      data-testid={`eaos-projects-bucket-${bucket.id}`}
    >
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">
          {bucket.label}{" "}
          <span className="text-xs font-normal text-muted-foreground">({bucket.rows.length})</span>
        </h2>
      </header>
      {bucket.rows.length === 0 ? (
        <p
          className="rounded-md border border-dashed border-border bg-card p-3 text-xs text-muted-foreground"
          data-testid={`eaos-projects-bucket-${bucket.id}-empty`}
        >
          {defaultEmpty}
        </p>
      ) : (
        <ul
          className={
            viewMode === "list"
              ? "flex flex-col gap-1.5"
              : "grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3"
          }
          data-testid={`eaos-projects-bucket-${bucket.id}-rows`}
          data-eaos-view-mode={viewMode}
        >
          {bucket.rows.map((row) => (
            <ProjectRow
              key={row.id}
              row={row}
              referenceNow={referenceNow}
              isOperator={isOperator}
              viewMode={viewMode}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ProjectRow({
  row,
  referenceNow,
  isOperator,
  viewMode,
}: {
  row: ProjectRoadmapRow;
  referenceNow: Date;
  isOperator: boolean;
  viewMode: EaosViewMode;
}) {
  if (viewMode === "list") {
    return <ProjectRowList row={row} isOperator={isOperator} />;
  }
  return (
    <li
      className="flex flex-col gap-2 rounded-md border border-border bg-card p-3"
      data-testid="eaos-projects-row"
      data-project-id={row.id}
      data-project-status={row.status}
      data-eaos-view-mode="cards"
    >
      <div className="flex flex-wrap items-center gap-2">
        <EaosStateChip
          label={statusChipLabel(row.status)}
          prefix="Status"
          title={`Status: ${row.status}`}
        />
        {row.archivedAt ? (
          <span
            data-testid="eaos-projects-row-archived"
            className="rounded-md border border-dashed border-border bg-background px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
          >
            Archived {row.archivedAt.toISOString().slice(0, 10)}
          </span>
        ) : null}
        {row.pauseReason ? (
          <span
            data-testid="eaos-projects-row-pause-reason"
            className="rounded-md border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
          >
            Paused · {row.pauseReason.replace(/_/g, " ")}
          </span>
        ) : null}
      </div>
      <div className="flex items-start gap-2">
        <Layers aria-hidden="true" className="mt-0.5 h-4 w-4 text-foreground" />
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="truncate text-sm font-medium text-foreground" data-testid="eaos-projects-row-name">
            {redactSecretLikeText(row.name)}
          </p>
          {row.description ? (
            <p
              className="line-clamp-2 text-xs text-muted-foreground"
              data-testid="eaos-projects-row-description"
            >
              {redactSecretLikeText(row.description)}
            </p>
          ) : null}
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
        <div className="flex flex-col" data-testid="eaos-projects-row-goals">
          <dt className="uppercase tracking-wide">Goals</dt>
          <dd className="text-foreground tabular-nums">{row.goalCount}</dd>
        </div>
        <div className="flex flex-col" data-testid="eaos-projects-row-workspaces">
          <dt className="uppercase tracking-wide">Workspaces</dt>
          <dd className="text-foreground tabular-nums">{row.workspaceCount}</dd>
        </div>
        <div className="flex flex-col" data-testid="eaos-projects-row-target">
          <dt className="uppercase tracking-wide">Target</dt>
          <dd className="text-foreground">{row.targetDate ?? "—"}</dd>
        </div>
        <div className="flex flex-col" data-testid="eaos-projects-row-lead">
          <dt className="uppercase tracking-wide">Lead agent</dt>
          <dd className="text-foreground">{row.leadAgentId ? row.leadAgentId.slice(0, 8) : "—"}</dd>
        </div>
      </dl>
      {row.goalTitles.length > 0 ? (
        <ul className="flex flex-wrap gap-1" data-testid="eaos-projects-row-goal-titles">
          {row.goalTitles.slice(0, 3).map((title, index) => (
            <li
              key={`${row.id}-goal-${index}`}
              className="rounded-md border border-dashed border-border bg-background px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
            >
              <CalendarClock aria-hidden="true" className="mr-1 inline h-2.5 w-2.5" />
              {redactSecretLikeText(title)}
            </li>
          ))}
          {row.goalTitles.length > 3 ? (
            <li className="rounded-md border border-dashed border-border bg-background px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              +{row.goalTitles.length - 3} more
            </li>
          ) : null}
        </ul>
      ) : null}
      {/*
        LET-513 §6 — `row.kernelRoute` points at the legacy Paperclip
        project detail (`/projects/:id`), which leaves the EAOS shell. Only
        operator-class viewers see the escape hatch, and it is explicitly
        labeled "Open in admin →" so the route change is intentional.
        Customer viewers see no operator-only nav from this row.
      */}
      {isOperator ? (
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <Link
            to={row.kernelRoute}
            className="font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            data-testid="eaos-projects-row-kernel-link"
          >
            Open in admin →
          </Link>
        </div>
      ) : null}
    </li>
  );
}

function ProjectRowList({
  row,
  isOperator,
}: {
  row: ProjectRoadmapRow;
  isOperator: boolean;
}) {
  return (
    <li
      className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2 text-[12px]"
      data-testid="eaos-projects-row"
      data-project-id={row.id}
      data-project-status={row.status}
      data-eaos-view-mode="list"
    >
      <EaosStateChip
        label={statusChipLabel(row.status)}
        prefix="Status"
        title={`Status: ${row.status}`}
      />
      <div className="min-w-0 flex-1">
        <p
          className="truncate font-medium text-foreground"
          data-testid="eaos-projects-row-name"
        >
          {redactSecretLikeText(row.name)}
        </p>
        {row.description ? (
          <p
            className="truncate text-[11px] text-muted-foreground"
            data-testid="eaos-projects-row-description"
          >
            {redactSecretLikeText(row.description)}
          </p>
        ) : null}
      </div>
      <div className="hidden flex-col text-[11px] text-muted-foreground sm:flex sm:flex-row sm:items-center sm:gap-3">
        <span
          className="tabular-nums"
          data-testid="eaos-projects-row-goals-list"
          title={`${row.goalCount} active goals`}
        >
          {row.goalCount} goals
        </span>
        <span
          className="tabular-nums"
          data-testid="eaos-projects-row-workspaces-list"
          title={`${row.workspaceCount} execution workspaces`}
        >
          {row.workspaceCount} ws
        </span>
        <span data-testid="eaos-projects-row-target-list">
          {row.targetDate ?? "—"}
        </span>
      </div>
      {isOperator ? (
        <Link
          to={row.kernelRoute}
          className="shrink-0 text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          data-testid="eaos-projects-row-kernel-link"
        >
          Open in admin →
        </Link>
      ) : null}
    </li>
  );
}

function statusChipLabel(
  status: ProjectRoadmapRow["status"],
): string {
  switch (status) {
    case "completed":
      return "SHIPPED";
    case "in_progress":
      return "ACTIVE";
    case "planned":
      return "PLANNED";
    case "backlog":
      return "BACKLOG";
    case "cancelled":
      return "STOPPED";
  }
}
