// LET-484 working-product slice — read-only `/eaos/projects` roadmap.
//
// Source of truth: `projectsApi.list(companyId)` + `goalsApi.list(companyId)`.
// The page wires the two reads together so each project row carries the
// linked goal titles, lead agent, target date, and workspace count without
// the operator having to context-switch. Action verbs (start workspace,
// archive, configure) stay inside the kernel project detail.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, Layers } from "lucide-react";
import { goalsApi } from "@/api/goals";
import { projectsApi } from "@/api/projects";
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
  const { selectedCompanyId, selectedCompany } = useCompany();

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

  const buckets = useMemo<readonly ProjectRoadmapBucket[]>(
    () => groupRoadmap(projectsQuery.data ?? [], goalsQuery.data ?? []),
    [projectsQuery.data, goalsQuery.data],
  );
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
      className="flex flex-col gap-5"
      data-testid="eaos-projects-page"
      data-eaos-data-connected={dataConnected ? "true" : "false"}
    >
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2" data-testid="eaos-projects-posture">
          <EaosStateChip label={SHELL_POSTURE_LABEL} prefix={SHELL_POSTURE_PREFIX} />
          {dataConnected ? (
            <EaosStateChip
              label="BACKEND-BACKED"
              prefix="Roadmap"
              title="Projects + goals derived from canonical /api/companies/:companyId/projects + /goals"
            />
          ) : (
            <EaosStateChip label={NOT_CONNECTED_DATA_LABEL} prefix={NOT_CONNECTED_DATA_PREFIX} />
          )}
          <span
            className="text-[11px] uppercase tracking-wide text-muted-foreground"
            data-testid="eaos-projects-posture-note"
          >
            {dataConnected
              ? `Live read · ${selectedCompany?.name ? redactSecretLikeText(selectedCompany.name) : "current company scope"}`
              : NOT_CONNECTED_DATA_NOTE}
          </span>
        </div>
        <div className="flex flex-col gap-1.5 sm:flex-row sm:items-end sm:justify-between sm:gap-3">
          <div className="flex flex-col gap-1">
            <h1
              id="eaos-projects-title"
              className="text-2xl font-semibold tracking-tight text-foreground"
              data-testid="eaos-projects-title"
            >
              Projects / Goals
            </h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Strategic projects and linked goals for the current company scope. Each project
              row shows lead agent, target date, workspace count, and the goals it advances.
              Workspace start / archive / configure verbs stay inside the kernel project page.
            </p>
          </div>
        </div>
      </header>

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
          {buckets.map((bucket) => (
            <RoadmapBucketSection
              key={bucket.id}
              bucket={bucket}
              referenceNow={referenceNow}
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
      <p className="font-medium">Could not load projects + goals.</p>
      <p className="mt-1 text-xs">{redactSecretLikeText(message)}</p>
      <p className="mt-1 text-xs">
        Rows and counts are hidden because no backend-backed roadmap is available. Retry by
        refreshing or use the Kernel/Admin projects tab.
      </p>
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
      No projects are visible in the current company scope yet.
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
}: {
  bucket: ProjectRoadmapBucket;
  referenceNow: Date;
  defaultEmpty: string;
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
          className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3"
          data-testid={`eaos-projects-bucket-${bucket.id}-rows`}
        >
          {bucket.rows.map((row) => (
            <ProjectRow key={row.id} row={row} referenceNow={referenceNow} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ProjectRow({ row, referenceNow }: { row: ProjectRoadmapRow; referenceNow: Date }) {
  return (
    <li
      className="flex flex-col gap-2 rounded-md border border-border bg-card p-3"
      data-testid="eaos-projects-row"
      data-project-id={row.id}
      data-project-status={row.status}
    >
      <div className="flex flex-wrap items-center gap-2">
        <EaosStateChip
          label={statusChipLabel(row.status)}
          prefix="Project"
          title={`Status from backend: ${row.status}.`}
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
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <Link
          to={row.kernelRoute}
          className="font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          data-testid="eaos-projects-row-kernel-link"
        >
          Open in Kernel/Admin →
        </Link>
        <span className="text-muted-foreground">No live action on this surface.</span>
      </div>
    </li>
  );
}

function statusChipLabel(
  status: ProjectRoadmapRow["status"],
): "APPLIED" | "BACKEND-BACKED" | "PREVIEW" | "FAILED" {
  switch (status) {
    case "completed":
      return "APPLIED";
    case "in_progress":
      return "BACKEND-BACKED";
    case "planned":
    case "backlog":
      return "PREVIEW";
    case "cancelled":
      return "FAILED";
  }
}
