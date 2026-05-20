// LET-484 working-product slice — read-only `/eaos/approvals` queue.
//
// Source of truth: `approvalsApi.list(companyId)` (`GET
// /api/companies/:companyId/approvals`). Truthful LET-187 chips:
//   - Shell · BACKEND-BACKED constant for every `/eaos` render.
//   - Data · BACKEND-BACKED only after a company-scoped read succeeds.
//   - Approve / Reject / Request revision are NOT rendered here. Decisions
//     stay inside the kernel `/approvals/:id` page so this slice cannot
//     accidentally fire a destructive call. Each row links out for action.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertOctagon, ShieldCheck } from "lucide-react";
import { approvalsApi } from "@/api/approvals";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { EaosStateChip } from "../EaosStateChip";
import { redactSecretLikeText } from "../secret-redact";
import {
  groupApprovalsForQueue,
  summarizeApprovals,
  type ApprovalQueueBucket,
  type ApprovalQueueCounts,
  type ApprovalQueueRow,
} from "./approval-queue";

export interface ApprovalsQueuePageProps {
  now?: Date;
}

export function ApprovalsQueuePage({ now }: ApprovalsQueuePageProps = {}) {
  const { selectedCompanyId } = useCompany();

  const approvalsQuery = useQuery({
    queryKey: selectedCompanyId
      ? [...queryKeys.approvals.list(selectedCompanyId), "eaos-queue"]
      : ["approvals", "__no-company__", "eaos-queue"],
    queryFn: () => approvalsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const buckets = useMemo<readonly ApprovalQueueBucket[]>(
    () => groupApprovalsForQueue(approvalsQuery.data ?? []),
    [approvalsQuery.data],
  );
  const counts = useMemo<ApprovalQueueCounts>(
    () => summarizeApprovals(approvalsQuery.data ?? []),
    [approvalsQuery.data],
  );

  const isLoading = Boolean(selectedCompanyId) && approvalsQuery.isLoading;
  const isError = Boolean(selectedCompanyId) && approvalsQuery.isError;
  const hasData = !isLoading && !isError && approvalsQuery.isSuccess;
  const dataConnected = hasData;
  const referenceNow = now ?? new Date();

  return (
    <section
      aria-labelledby="eaos-approvals-title"
      className="flex flex-col gap-5"
      data-testid="eaos-approvals-page"
      data-eaos-data-connected={dataConnected ? "true" : "false"}
    >
      <header className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between sm:gap-3">
        <h1
          id="eaos-approvals-title"
          className="text-xl font-semibold tracking-tight text-foreground"
          data-testid="eaos-approvals-title"
        >
          Approvals
        </h1>
      </header>

      {!selectedCompanyId ? (
        <NoCompanyState />
      ) : isLoading ? (
        <LoadingState />
      ) : isError ? (
        <ErrorState message={readErrorMessage(approvalsQuery.error)} />
      ) : approvalsQuery.data && approvalsQuery.data.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <SummaryStrip counts={counts} />
          {buckets.map((bucket) => (
            <QueueBucket
              key={bucket.id}
              bucket={bucket}
              referenceNow={referenceNow}
              defaultEmpty={
                bucket.id === "pending"
                  ? "No pending approvals — the queue is clear."
                  : bucket.id === "revision_requested"
                    ? "No revisions awaiting the requester."
                    : "No recent decisions in this scope."
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
  return "Failed to load approvals.";
}

function NoCompanyState() {
  return (
    <div
      role="status"
      className="rounded-md border border-dashed border-border bg-card p-4 text-sm text-muted-foreground"
      data-testid="eaos-approvals-no-company"
    >
      Select a company scope from the top bar to load the approvals queue. This surface reads
      approvals for the currently selected company only.
    </div>
  );
}

function LoadingState() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground"
      data-testid="eaos-approvals-loading"
    >
      Loading approvals from canonical records…
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100"
      data-testid="eaos-approvals-error"
    >
      <p className="font-medium">Could not load approvals.</p>
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
      data-testid="eaos-approvals-empty"
    >
      No approvals yet. Requests show up here when agents or the board need a decision.
    </div>
  );
}

function SummaryStrip({ counts }: { counts: ApprovalQueueCounts }) {
  const items: Array<{ id: string; label: string; value: number }> = [
    { id: "total", label: "Total", value: counts.total },
    { id: "pending", label: "Pending", value: counts.pending },
    { id: "revision-requested", label: "Revision", value: counts.revisionRequested },
    { id: "high-risk", label: "High risk", value: counts.highRisk },
    { id: "approved", label: "Approved", value: counts.approved },
    { id: "rejected", label: "Rejected", value: counts.rejected },
  ];
  return (
    <dl
      data-testid="eaos-approvals-summary"
      className="grid grid-cols-2 gap-2 rounded-md border border-border bg-card p-3 sm:grid-cols-3 lg:grid-cols-6"
    >
      {items.map((item) => (
        <div
          key={item.id}
          data-testid={`eaos-approvals-summary-${item.id}`}
          className="flex flex-col gap-0.5"
        >
          <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{item.label}</dt>
          <dd className="text-lg font-semibold text-foreground tabular-nums">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function QueueBucket({
  bucket,
  referenceNow,
  defaultEmpty,
}: {
  bucket: ApprovalQueueBucket;
  referenceNow: Date;
  defaultEmpty: string;
}) {
  return (
    <section
      aria-label={bucket.label}
      className="flex flex-col gap-2"
      data-testid={`eaos-approvals-bucket-${bucket.id}`}
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
          data-testid={`eaos-approvals-bucket-${bucket.id}-empty`}
        >
          {defaultEmpty}
        </p>
      ) : (
        <ul
          className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3"
          data-testid={`eaos-approvals-bucket-${bucket.id}-rows`}
        >
          {bucket.rows.map((row) => (
            <ApprovalRow key={row.id} row={row} referenceNow={referenceNow} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ApprovalRow({ row, referenceNow }: { row: ApprovalQueueRow; referenceNow: Date }) {
  const isOpen = row.status === "pending" || row.status === "revision_requested";
  return (
    <li
      className="flex flex-col gap-2 rounded-md border border-border bg-card p-3"
      data-testid="eaos-approvals-row"
      data-approval-id={row.id}
      data-approval-status={row.status}
      data-approval-risk={row.riskLevel}
    >
      <div className="flex flex-wrap items-center gap-2">
        <EaosStateChip
          label={statusChipLabel(row.status)}
          prefix="Approval"
          title={`Status from backend: ${row.status}.`}
        />
        <RiskBadge level={row.riskLevel} />
        <span className="rounded-md border border-dashed border-border bg-background px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {row.typeLabel}
        </span>
      </div>
      <div className="flex items-start gap-2">
        {row.riskLevel === "critical" || row.riskLevel === "high" ? (
          <AlertOctagon aria-hidden="true" className="mt-0.5 h-4 w-4 text-amber-600" />
        ) : (
          <ShieldCheck aria-hidden="true" className="mt-0.5 h-4 w-4 text-foreground" />
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="truncate text-sm font-medium text-foreground" data-testid="eaos-approvals-row-summary">
            {redactSecretLikeText(row.summary)}
          </p>
          {row.decisionNote ? (
            <p
              className="line-clamp-2 text-xs text-muted-foreground"
              data-testid="eaos-approvals-row-decision-note"
            >
              {redactSecretLikeText(row.decisionNote)}
            </p>
          ) : null}
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
        <div className="flex flex-col" data-testid="eaos-approvals-row-requested">
          <dt className="uppercase tracking-wide">Requested</dt>
          <dd className="text-foreground">{relativeOrNever(row.requestedAt, referenceNow)}</dd>
        </div>
        <div className="flex flex-col" data-testid="eaos-approvals-row-decided">
          <dt className="uppercase tracking-wide">{isOpen ? "Awaiting" : "Decided"}</dt>
          <dd className="text-foreground">
            {row.decidedAt
              ? relativeOrNever(row.decidedAt, referenceNow)
              : isOpen
                ? `${relativeOrNever(row.requestedAt, referenceNow)} (still open)`
                : "—"}
          </dd>
        </div>
      </dl>
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <Link
          to={row.kernelRoute}
          className="font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          data-testid="eaos-approvals-row-kernel-link"
        >
          {isOpen ? "Open to decide →" : "Open decision →"}
        </Link>
        <span className="text-muted-foreground">Approve / reject lives on the detail page.</span>
      </div>
    </li>
  );
}

function statusChipLabel(status: ApprovalQueueRow["status"]): "APPROVAL REQUIRED" | "APPLIED" | "FAILED" | "PREVIEW" {
  switch (status) {
    case "pending":
    case "revision_requested":
      return "APPROVAL REQUIRED";
    case "approved":
      return "APPLIED";
    case "rejected":
      return "FAILED";
    case "cancelled":
      return "PREVIEW";
  }
}

function RiskBadge({ level }: { level: ApprovalQueueRow["riskLevel"] }) {
  const tone =
    level === "critical"
      ? "border-rose-400 bg-rose-50 text-rose-900 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-100"
      : level === "high"
        ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
        : level === "medium"
          ? "border-yellow-200 bg-yellow-50 text-yellow-900 dark:border-yellow-700 dark:bg-yellow-950 dark:text-yellow-100"
          : "border-border bg-background text-muted-foreground";
  return (
    <span
      data-testid="eaos-approvals-row-risk"
      data-risk-level={level}
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${tone}`}
    >
      {`Risk · ${level}`}
    </span>
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
