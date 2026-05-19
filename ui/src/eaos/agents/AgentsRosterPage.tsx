// LET-484 working-product slice — read-only `/eaos/agents` roster.
//
// Source of truth: `agentsApi.list(companyId)` (`GET
// /api/companies/:companyId/agents`). The roster mirrors canonical Agent
// records and renders truthful posture chips per LET-187:
//   - Shell · BACKEND-BACKED is constant for any `/eaos` render.
//   - Data · BACKEND-BACKED only once a non-empty company-scoped read
//     succeeds; otherwise Data · PREVIEW · Not connected.
//
// No live actions are rendered here. Pause/resume/approve/terminate stay
// inside the kernel agent detail page (`/agents/:id`) which links out from
// each row. Budget figures show backend snapshots and are not actionable.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Cpu, ShieldAlert } from "lucide-react";
import { agentsApi } from "@/api/agents";
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
  buildAgentRosterRow,
  groupRosterByRole,
  summarizeAgents,
  type AgentRosterCounts,
  type AgentRosterRow,
} from "./agent-roster";

interface AgentsRosterPageProps {
  // Tests inject a fixed `now` so freshness copy is deterministic. In
  // production we default to `new Date()`.
  now?: Date;
}

export function AgentsRosterPage({ now }: AgentsRosterPageProps = {}) {
  const { selectedCompanyId, selectedCompany } = useCompany();

  const agentsQuery = useQuery({
    queryKey: selectedCompanyId
      ? [...queryKeys.agents.list(selectedCompanyId), "eaos-roster"]
      : ["agents", "__no-company__", "eaos-roster"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const rows = useMemo<AgentRosterRow[]>(() => {
    const agents = agentsQuery.data ?? [];
    return agents.map(buildAgentRosterRow);
  }, [agentsQuery.data]);

  const counts = useMemo(() => summarizeAgents(agentsQuery.data ?? []), [agentsQuery.data]);
  const groups = useMemo(() => groupRosterByRole(rows), [rows]);

  const isLoading = Boolean(selectedCompanyId) && agentsQuery.isLoading;
  const isError = Boolean(selectedCompanyId) && agentsQuery.isError;
  const hasData = !isLoading && !isError && agentsQuery.isSuccess;
  const dataConnected = hasData;

  const referenceNow = now ?? new Date();

  return (
    <section
      aria-labelledby="eaos-agents-title"
      className="flex flex-col gap-5"
      data-testid="eaos-agents-page"
      data-eaos-data-connected={dataConnected ? "true" : "false"}
    >
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2" data-testid="eaos-agents-posture">
          <EaosStateChip label={SHELL_POSTURE_LABEL} prefix={SHELL_POSTURE_PREFIX} />
          {dataConnected ? (
            <EaosStateChip
              label="BACKEND-BACKED"
              prefix="Data"
              title="Roster sourced from canonical Agent records via /api/companies/:companyId/agents"
            />
          ) : (
            <EaosStateChip label={NOT_CONNECTED_DATA_LABEL} prefix={NOT_CONNECTED_DATA_PREFIX} />
          )}
          <span
            className="text-[11px] uppercase tracking-wide text-muted-foreground"
            data-testid="eaos-agents-posture-note"
          >
            {dataConnected
              ? `Live read · ${selectedCompany?.name ? redactSecretLikeText(selectedCompany.name) : "current company scope"}`
              : NOT_CONNECTED_DATA_NOTE}
          </span>
        </div>
        <div className="flex flex-col gap-1.5 sm:flex-row sm:items-end sm:justify-between sm:gap-3">
          <div className="flex flex-col gap-1">
            <h1
              id="eaos-agents-title"
              className="text-2xl font-semibold tracking-tight text-foreground"
              data-testid="eaos-agents-title"
            >
              Agents / Teams
            </h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Operator roster derived read-only from canonical Agent records. Pause / resume /
              approve / terminate stay inside the kernel detail page; this surface only renders
              status, adapter, heartbeat freshness, and budget snapshots.
            </p>
          </div>
        </div>
      </header>

      {!selectedCompanyId ? (
        <NoCompanyState />
      ) : isLoading ? (
        <LoadingState />
      ) : isError ? (
        <ErrorState message={readErrorMessage(agentsQuery.error)} />
      ) : rows.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <SummaryStrip counts={counts} />
          {groups.map((group) => (
            <RosterGroup
              key={group.role}
              roleLabel={group.roleLabel}
              rows={group.rows}
              referenceNow={referenceNow}
            />
          ))}
        </>
      )}
    </section>
  );
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Failed to load agent roster.";
}

function NoCompanyState() {
  return (
    <div
      role="status"
      className="rounded-md border border-dashed border-border bg-card p-4 text-sm text-muted-foreground"
      data-testid="eaos-agents-no-company"
    >
      Select a company scope from the top bar to load the agent roster. This surface reads agents
      for the currently selected company only.
    </div>
  );
}

function LoadingState() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground"
      data-testid="eaos-agents-loading"
    >
      Loading agent roster from canonical records…
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100"
      data-testid="eaos-agents-error"
    >
      <p className="font-medium">Could not load agents.</p>
      <p className="mt-1 text-xs">{redactSecretLikeText(message)}</p>
      <p className="mt-1 text-xs">
        Counts and rows are hidden because no backend-backed roster is available. Retry by
        refreshing or use the Kernel/Admin agent list.
      </p>
    </div>
  );
}

function EmptyState() {
  return (
    <div
      role="status"
      className="rounded-md border border-dashed border-border bg-card p-4 text-sm text-muted-foreground"
      data-testid="eaos-agents-empty"
    >
      No agents are visible in the current company scope yet. When the company onboards an agent it
      will appear here.
    </div>
  );
}

function SummaryStrip({ counts }: { counts: AgentRosterCounts }) {
  const items: Array<{ id: string; label: string; value: number }> = [
    { id: "total", label: "Total", value: counts.total },
    { id: "active", label: "Active", value: counts.active },
    { id: "running", label: "Running", value: counts.running },
    { id: "idle", label: "Idle", value: counts.idle },
    { id: "paused", label: "Paused", value: counts.paused },
    { id: "error", label: "Error", value: counts.error },
    { id: "pending-approval", label: "Pending", value: counts.pendingApproval },
    { id: "terminated", label: "Terminated", value: counts.terminated },
  ];
  return (
    <dl
      data-testid="eaos-agents-summary"
      className="grid grid-cols-2 gap-2 rounded-md border border-border bg-card p-3 sm:grid-cols-4 lg:grid-cols-8"
    >
      {items.map((item) => (
        <div
          key={item.id}
          data-testid={`eaos-agents-summary-${item.id}`}
          className="flex flex-col gap-0.5"
        >
          <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{item.label}</dt>
          <dd className="text-lg font-semibold text-foreground tabular-nums">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function RosterGroup({
  roleLabel,
  rows,
  referenceNow,
}: {
  roleLabel: string;
  rows: readonly AgentRosterRow[];
  referenceNow: Date;
}) {
  return (
    <section
      aria-label={`${roleLabel} agents`}
      className="flex flex-col gap-2"
      data-testid={`eaos-agents-group-${slug(roleLabel)}`}
    >
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">
          {roleLabel}{" "}
          <span className="text-xs font-normal text-muted-foreground">({rows.length})</span>
        </h2>
      </header>
      <ul
        className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3"
        data-testid={`eaos-agents-group-${slug(roleLabel)}-rows`}
      >
        {rows.map((row) => (
          <AgentRow key={row.id} row={row} referenceNow={referenceNow} />
        ))}
      </ul>
    </section>
  );
}

function AgentRow({ row, referenceNow }: { row: AgentRosterRow; referenceNow: Date }) {
  return (
    <li
      className="flex flex-col gap-2 rounded-md border border-border bg-card p-3"
      data-testid="eaos-agents-row"
      data-agent-id={row.id}
      data-agent-status={row.status}
    >
      <div className="flex flex-wrap items-center gap-2">
        <EaosStateChip
          label={row.statusChipLabel}
          prefix="Agent"
          title={statusTitle(row)}
        />
        <span className="rounded-md border border-dashed border-border bg-background px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {row.adapterType}
        </span>
        {row.status === "paused" && row.pauseReason ? (
          <span
            data-testid="eaos-agents-row-pause-reason"
            className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground"
          >
            <ShieldAlert aria-hidden="true" className="h-3 w-3" />
            {row.pauseReason.replace(/_/g, " ")}
          </span>
        ) : null}
      </div>
      <div className="flex items-start gap-2">
        <Cpu aria-hidden="true" className="mt-0.5 h-4 w-4 text-foreground" />
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="truncate text-sm font-medium text-foreground" data-testid="eaos-agents-row-name">
            {redactSecretLikeText(row.name)}
          </p>
          <p className="text-xs text-muted-foreground" data-testid="eaos-agents-row-role">
            {row.roleLabel}
            {row.title ? <> · <span>{redactSecretLikeText(row.title)}</span></> : null}
          </p>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
        <div className="flex flex-col" data-testid="eaos-agents-row-heartbeat">
          <dt className="uppercase tracking-wide">Last heartbeat</dt>
          <dd className="text-foreground">{relativeOrNever(row.lastHeartbeatAt, referenceNow)}</dd>
        </div>
        <div className="flex flex-col" data-testid="eaos-agents-row-budget">
          <dt className="uppercase tracking-wide">Budget · spent / cap</dt>
          <dd className="text-foreground tabular-nums">
            {formatUsdCents(row.spentMonthlyCents)} / {formatUsdCents(row.budgetMonthlyCents)}
          </dd>
        </div>
      </dl>
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <Link
          to={row.kernelRoute}
          className="font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          data-testid="eaos-agents-row-kernel-link"
        >
          Open in Kernel/Admin →
        </Link>
        <span className="text-muted-foreground">No live action on this surface.</span>
      </div>
    </li>
  );
}

function statusTitle(row: AgentRosterRow): string {
  const base = `Agent status from backend: ${row.status}.`;
  if (row.status === "paused" && row.pauseReason) {
    return `${base} Pause reason: ${row.pauseReason}.`;
  }
  return base;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function relativeOrNever(when: Date | null, now: Date): string {
  if (!when) return "Never";
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

function formatUsdCents(cents: number): string {
  if (!Number.isFinite(cents) || cents <= 0) return "$0";
  const dollars = cents / 100;
  if (dollars >= 100) return `$${dollars.toFixed(0)}`;
  return `$${dollars.toFixed(2)}`;
}
