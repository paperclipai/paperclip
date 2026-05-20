// LET-424 Mission Control thin slice (read-only).
//
// Frontend contract: LET-409 §14 (Mission task-object), §15.1–§15.3
// (truth/freshness/confidence chips, no-live-action posture, kernel
// backlinks). This surface only reads canonical Issue records from
// `/api/companies/:companyId/issues` and renders a backend-derived mission
// view through the LET-424 mission-resolver.
//
// Posture rules:
//   - Shell chip is BACKEND-BACKED whenever the route is rendered.
//   - Data chip becomes BACKEND-BACKED only after a successful issue fetch.
//     Until then (loading / error), the data chip is PREVIEW · Not connected.
//   - Counts come exclusively from the resolved Issue rows; no Stub data
//     contributes to any counted total, in line with LET-409 §10/§15.
//   - Per-row truth labels follow `MissionRow.truthLabel`/`*Truth` fields:
//     Backend-backed for raw fields, Backend-derived for resolver rollups.
//   - No mutating actions (approve / deploy / restart / spend / vendor) are
//     rendered. Only safe links back to kernel issue pages and the LET-409
//     spec doc.
//   - Live-action keyword detection raises an advisory "live-action mention"
//     chip; it does NOT enable any live control here.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { useCompany } from "@/context/CompanyContext";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { EaosStateChip } from "../EaosStateChip";
import { useEaosViewerRole } from "../useEaosViewerRole";
import {
  bucketMissions,
  resolveMissionRow,
  summarizeMissionList,
  type MissionFreshnessLabel,
  type MissionPrimaryState,
  type MissionRow,
  type MissionTruthLabel,
} from "./mission-resolver";

const MISSION_FETCH_LIMIT = 100;

interface MissionsListPageProps {
  // Tests inject a fixed `now` so freshness chips are deterministic. In
  // production we let the resolver default to `new Date()` per call.
  now?: Date;
}

export function MissionsListPage({ now }: MissionsListPageProps = {}) {
  const { selectedCompanyId } = useCompany();
  const { isOperator } = useEaosViewerRole();

  const issuesQuery = useQuery({
    queryKey: selectedCompanyId
      ? [...queryKeys.issues.list(selectedCompanyId), "eaos-missions", MISSION_FETCH_LIMIT]
      : ["issues", "__no-company__", "eaos-missions"],
    queryFn: () =>
      issuesApi.list(selectedCompanyId!, {
        limit: MISSION_FETCH_LIMIT,
        includeBlockedBy: true,
      }),
    enabled: Boolean(selectedCompanyId),
  });

  const rows = useMemo<MissionRow[]>(() => {
    const issues: Issue[] = issuesQuery.data ?? [];
    const resolveAt = now ?? new Date();
    return issues.map((issue) => resolveMissionRow(issue, resolveAt));
  }, [issuesQuery.data, now]);

  const buckets = useMemo(() => bucketMissions(rows), [rows]);
  const summary = useMemo(() => summarizeMissionList(rows), [rows]);

  const isLoading = Boolean(selectedCompanyId) && issuesQuery.isLoading;
  const isError = Boolean(selectedCompanyId) && issuesQuery.isError;
  const hasData = !isLoading && !isError && issuesQuery.isSuccess;
  const dataConnected = hasData;

  return (
    <section
      aria-labelledby="eaos-missions-title"
      className="flex flex-col gap-5"
      data-testid="eaos-missions-page"
      data-eaos-data-connected={dataConnected ? "true" : "false"}
    >
      <header className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between sm:gap-3">
        <h1
          id="eaos-missions-title"
          className="text-xl font-semibold tracking-tight text-foreground"
          data-testid="eaos-missions-title"
        >
          Missions
        </h1>
      </header>

      {!selectedCompanyId ? (
        <NoCompanyState />
      ) : isLoading ? (
        <LoadingState />
      ) : isError ? (
        <ErrorState message={readErrorMessage(issuesQuery.error)} />
      ) : rows.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <SummaryStrip summary={summary} />
          <MissionBucket
            id="active"
            title="Active"
            description="In progress, or queued with an owner."
            rows={buckets.active}
            isOperator={isOperator}
          />
          <MissionBucket
            id="blocked"
            title="Blocked"
            description="Waiting on a dependency or external unblock."
            rows={buckets.blocked}
            isOperator={isOperator}
          />
          <MissionBucket
            id="in-review"
            title="In review"
            description="Awaiting reviewer or approval owner."
            rows={buckets.inReview}
            isOperator={isOperator}
          />
          <MissionBucket
            id="done-with-evidence"
            title="Done"
            description="Closed with a plan or work product attached."
            rows={buckets.doneWithEvidence}
            isOperator={isOperator}
          />
          <MissionBucket
            id="other"
            title="Other"
            description="Cancelled, stale, or needing a next owner."
            rows={buckets.other}
            isOperator={isOperator}
            allowEmpty
          />
        </>
      )}
    </section>
  );
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Failed to load canonical issues.";
}

function NoCompanyState() {
  return (
    <div
      role="status"
      className="rounded-md border border-dashed border-border bg-card p-4 text-sm text-muted-foreground"
      data-testid="eaos-missions-no-company"
    >
      Select a company from the top bar to see its missions.
    </div>
  );
}

function LoadingState() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground"
      data-testid="eaos-missions-loading"
    >
      Loading missions…
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100"
      data-testid="eaos-missions-error"
    >
      <p className="font-medium">Could not load missions.</p>
      <p className="mt-1 text-xs">{message}</p>
      <p className="mt-1 text-xs">Refresh to try again.</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div
      role="status"
      className="rounded-md border border-dashed border-border bg-card p-4 text-sm text-muted-foreground"
      data-testid="eaos-missions-empty"
    >
      No missions yet. New work will show up here.
    </div>
  );
}

interface SummaryStripProps {
  summary: ReturnType<typeof summarizeMissionList>;
}

function SummaryStrip({ summary }: SummaryStripProps) {
  const items: Array<{ id: string; label: string; value: number }> = [
    { id: "total", label: "Total", value: summary.totalBackendBacked },
    { id: "active", label: "Active", value: summary.active },
    { id: "blocked", label: "Blocked", value: summary.blocked },
    { id: "in-review", label: "In review", value: summary.inReview },
    { id: "done-with-evidence", label: "Done", value: summary.doneWithEvidence },
    { id: "stale", label: "Stale", value: summary.stale },
  ];
  return (
    <dl
      data-testid="eaos-missions-summary"
      className="grid grid-cols-2 gap-2 rounded-md border border-border bg-card p-3 sm:grid-cols-3 lg:grid-cols-6"
    >
      {items.map((item) => (
        <div
          key={item.id}
          data-testid={`eaos-missions-summary-${item.id}`}
          className="flex flex-col gap-0.5"
        >
          <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{item.label}</dt>
          <dd className="text-lg font-semibold text-foreground">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

interface MissionBucketProps {
  id: string;
  title: string;
  description: string;
  rows: readonly MissionRow[];
  isOperator: boolean;
  allowEmpty?: boolean;
}

function MissionBucket({ id, title, description, rows, isOperator, allowEmpty }: MissionBucketProps) {
  if (rows.length === 0 && !allowEmpty) return null;
  return (
    <section
      aria-labelledby={`eaos-missions-bucket-${id}-title`}
      className="flex flex-col gap-2"
      data-testid={`eaos-missions-bucket-${id}`}
    >
      <header className="flex flex-col gap-0.5">
        <h2
          id={`eaos-missions-bucket-${id}-title`}
          className="text-sm font-semibold text-foreground"
        >
          {title}{" "}
          <span className="text-xs font-normal text-muted-foreground">({rows.length})</span>
        </h2>
        <p className="text-xs text-muted-foreground">{description}</p>
      </header>
      {rows.length === 0 ? (
        <div
          className="rounded-md border border-dashed border-border bg-card p-3 text-xs text-muted-foreground"
          data-testid={`eaos-missions-bucket-${id}-empty`}
        >
          No issues currently in this bucket.
        </div>
      ) : (
        <ul className="flex flex-col gap-2" data-testid={`eaos-missions-bucket-${id}-rows`}>
          {rows.map((row) => (
            <MissionRowCard key={row.id} row={row} isOperator={isOperator} />
          ))}
        </ul>
      )}
    </section>
  );
}

function MissionRowCard({ row, isOperator }: { row: MissionRow; isOperator: boolean }) {
  return (
    <li
      className="flex flex-col gap-2 rounded-md border border-border bg-card p-3"
      data-testid="eaos-missions-row"
      data-mission-id={row.id}
      data-mission-primary-state={row.primaryState}
      data-mission-freshness={row.freshness}
    >
      <div className="flex flex-wrap items-center gap-2">
        <PrimaryStateChip state={row.primaryState} reason={row.primaryStateReason} />
        {isOperator ? <TruthChip truth={row.truthLabel} /> : null}
        {isOperator || row.freshness === "Stale" ? (
          <FreshnessChip freshness={row.freshness} updatedAt={row.updatedAt} />
        ) : null}
        {row.riskSummary.liveActionMentioned ? (
          <EaosStateChip
            label="APPROVAL REQUIRED"
            prefix="Risk"
            title="Mentions a live-action category (deploy, restart, prod, etc). Read-only advisory; no live control is rendered here."
          />
        ) : null}
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-foreground">
          {row.identifier ? (
            <span className="text-muted-foreground" data-testid="eaos-missions-row-identifier">
              {row.identifier} ·{" "}
            </span>
          ) : null}
          <span data-testid="eaos-missions-row-title">{row.title}</span>
        </p>
        <p className="text-xs text-muted-foreground" data-testid="eaos-missions-row-primary-reason">
          {row.primaryStateReason}
        </p>
      </div>
      <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <Field
          label="Owner"
          value={row.ownerSummary.currentLabel}
          truth={row.ownerSummary.currentTruth}
          reason={row.ownerSummary.currentReason}
          showTruth={isOperator}
        />
        <Field
          label="Evidence"
          value={
            row.evidenceSummary.hasPlanDocument || row.evidenceSummary.hasWorkProducts
              ? [
                  row.evidenceSummary.hasPlanDocument ? "plan doc" : null,
                  row.evidenceSummary.hasWorkProducts ? "work products" : null,
                ]
                  .filter(Boolean)
                  .join(" + ")
              : "None attached"
          }
          truth={row.evidenceSummary.truth}
          showTruth={isOperator}
        />
        <Field
          label="Next step"
          value={row.nextGateSummary.label}
          truth={row.nextGateSummary.truth}
          reason={row.nextGateSummary.requiresHuman ? "Needs a human" : undefined}
          showTruth={isOperator}
        />
        <Field
          label="Dependencies"
          value={`Blocks ${row.treeSummary.blocksCount} · Blocked by ${row.treeSummary.blockedByCount}`}
          truth={row.treeSummary.truth}
          showTruth={isOperator}
        />
      </dl>
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <Link
          to={row.kernelRoute}
          className="font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          data-testid="eaos-missions-row-kernel-link"
          disableIssueQuicklook
        >
          Open details →
        </Link>
      </div>
    </li>
  );
}

function Field({
  label,
  value,
  truth,
  reason,
  showTruth,
}: {
  label: string;
  value: string;
  truth: MissionTruthLabel;
  reason?: string;
  showTruth: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5" data-testid={`eaos-missions-row-field-${label.toLowerCase().replace(/\s+/g, "-")}`}>
      <dt className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
        {showTruth ? <TruthInlineMark truth={truth} /> : null}
      </dt>
      <dd className="text-foreground">{value}</dd>
      {reason ? <p className="text-[11px] text-muted-foreground">{reason}</p> : null}
    </div>
  );
}

function TruthInlineMark({ truth }: { truth: MissionTruthLabel }) {
  const tone =
    truth === "Backend-backed"
      ? "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-200"
      : "bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-200";
  const tip =
    truth === "Backend-backed"
      ? "Backend-backed: value mirrors a canonical Issue field."
      : "Backend-derived: rollup computed from canonical fields by the LET-424 resolver.";
  return (
    <span
      className={"rounded px-1 py-0 text-[9px] font-medium uppercase tracking-wide " + tone}
      title={tip}
      data-testid={`eaos-missions-field-truth-${truth.toLowerCase().replace(/[^a-z]+/g, "-")}`}
    >
      {truth === "Backend-backed" ? "Backed" : "Derived"}
    </span>
  );
}

const PRIMARY_STATE_LABELS: Record<MissionPrimaryState, string> = {
  active: "Active",
  "needs-next-owner": "Needs owner",
  blocked: "Blocked",
  "in-review": "In review",
  "release-held": "Release held",
  "done-with-evidence": "Done · evidence",
  "done-evidence-incomplete": "Done · no evidence",
  cancelled: "Cancelled",
  stale: "Stale",
};

const PRIMARY_STATE_TONE: Record<MissionPrimaryState, string> = {
  active:
    "border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-600 dark:bg-blue-950 dark:text-blue-100",
  "needs-next-owner":
    "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-600 dark:bg-amber-950 dark:text-amber-100",
  blocked:
    "border-red-300 bg-red-50 text-red-800 dark:border-red-600 dark:bg-red-950 dark:text-red-100",
  "in-review":
    "border-violet-300 bg-violet-50 text-violet-800 dark:border-violet-600 dark:bg-violet-950 dark:text-violet-100",
  "release-held":
    "border-orange-300 bg-orange-50 text-orange-900 dark:border-orange-600 dark:bg-orange-950 dark:text-orange-100",
  "done-with-evidence":
    "border-green-300 bg-green-50 text-green-800 dark:border-green-600 dark:bg-green-950 dark:text-green-100",
  "done-evidence-incomplete":
    "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-600 dark:bg-amber-950 dark:text-amber-100",
  cancelled:
    "border-zinc-300 bg-zinc-50 text-zinc-700 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200",
  stale:
    "border-zinc-300 bg-zinc-50 text-zinc-700 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200",
};

function PrimaryStateChip({
  state,
  reason,
}: {
  state: MissionPrimaryState;
  reason: string;
}) {
  return (
    <span
      data-testid={`eaos-missions-primary-state-${state}`}
      title={reason}
      className={
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide " +
        PRIMARY_STATE_TONE[state]
      }
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
      {PRIMARY_STATE_LABELS[state]}
    </span>
  );
}

function TruthChip({ truth }: { truth: MissionTruthLabel }) {
  // Operator-only provenance hint — soft tone, plain language, no
  // BACKEND-BACKED / PREVIEW jargon for non-operators (caller gates it).
  const tip =
    truth === "Backend-backed"
      ? "Row identity and status mirror canonical Issue fields."
      : "Row is derived from canonical Issue fields by the LET-424 resolver.";
  const label = truth === "Backend-backed" ? "Live data" : "Derived";
  return (
    <span
      data-testid={`eaos-missions-truth-${truth.toLowerCase().replace(/[^a-z]+/g, "-")}`}
      title={tip}
      className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current opacity-60" />
      {label}
    </span>
  );
}

const FRESHNESS_TONE: Record<MissionFreshnessLabel, string> = {
  Fresh:
    "border-green-300 bg-green-50 text-green-800 dark:border-green-600 dark:bg-green-950 dark:text-green-100",
  Aging:
    "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-600 dark:bg-amber-950 dark:text-amber-100",
  Stale:
    "border-zinc-300 bg-zinc-50 text-zinc-800 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100",
  Unknown:
    "border-zinc-300 bg-zinc-50 text-zinc-700 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200",
};

function FreshnessChip({
  freshness,
  updatedAt,
}: {
  freshness: MissionFreshnessLabel;
  updatedAt: Date | null;
}) {
  const tip = updatedAt
    ? `Last updated ${updatedAt.toISOString()}.`
    : "No recent activity recorded.";
  const label =
    freshness === "Fresh"
      ? "Fresh"
      : freshness === "Aging"
        ? "Aging"
        : freshness === "Stale"
          ? "Stale"
          : "Unknown activity";
  return (
    <span
      data-testid={`eaos-missions-freshness-${freshness.toLowerCase()}`}
      title={tip}
      className={
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium " +
        FRESHNESS_TONE[freshness]
      }
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
      {label}
    </span>
  );
}
