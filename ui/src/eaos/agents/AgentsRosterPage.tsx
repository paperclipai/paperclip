// LET-503 (LET-502 contract §5) — `/eaos/agents` is the first-class agent
// roster. Compact table, single-noun title ("Agents"), no header caveat
// paragraph. Source of truth stays `agentsApi.list(companyId)`. Pause /
// resume / approve / terminate remain in the kernel agent detail page;
// each row links there.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, ShieldAlert } from "lucide-react";
import { agentsApi } from "@/api/agents";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { redactSecretLikeText } from "../secret-redact";
import {
  buildAgentRosterRow,
  humanizeAdapterType,
  humanizeAgentStatus,
  summarizeAgents,
  type AgentRosterCounts,
  type AgentRosterRow,
} from "./agent-roster";
import { AgentAvatar } from "./AgentAvatar";

interface AgentsRosterPageProps {
  // Tests inject a fixed `now` so freshness copy is deterministic. In
  // production we default to `new Date()`.
  now?: Date;
}

export function AgentsRosterPage({ now }: AgentsRosterPageProps = {}) {
  const { selectedCompanyId } = useCompany();

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

  const isLoading = Boolean(selectedCompanyId) && agentsQuery.isLoading;
  const isError = Boolean(selectedCompanyId) && agentsQuery.isError;
  const hasData = !isLoading && !isError && agentsQuery.isSuccess;
  const dataConnected = hasData;

  const referenceNow = now ?? new Date();

  return (
    <section
      aria-labelledby="eaos-agents-title"
      className="flex min-h-0 flex-1 flex-col gap-4"
      data-testid="eaos-agents-page"
      data-eaos-data-connected={dataConnected ? "true" : "false"}
    >
      <header className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between sm:gap-3">
        <h1
          id="eaos-agents-title"
          className="text-xl font-semibold tracking-tight text-foreground"
          data-testid="eaos-agents-title"
        >
          Agents
        </h1>
        <Link
          to="/eaos/agents/new"
          data-testid="eaos-agents-new-cta"
          className="inline-flex items-center gap-1.5 self-start rounded-md border border-foreground bg-foreground px-3.5 py-2 text-sm font-semibold text-background shadow-sm hover:bg-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:self-auto"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          New agent
        </Link>
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
          <AgentTable rows={rows} referenceNow={referenceNow} />
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
    <p
      role="status"
      className="rounded-md border border-dashed border-border bg-card px-3 py-2 text-xs text-muted-foreground"
      data-testid="eaos-agents-no-company"
    >
      Select a company scope in the top bar to load agents.
    </p>
  );
}

function LoadingState() {
  return (
    <p
      role="status"
      aria-live="polite"
      className="rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground"
      data-testid="eaos-agents-loading"
    >
      Loading agents…
    </p>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100"
      data-testid="eaos-agents-error"
    >
      <p className="font-medium">Could not load agents.</p>
      <p className="mt-1">{redactSecretLikeText(message)}</p>
    </div>
  );
}

function EmptyState() {
  return (
    <p
      role="status"
      className="rounded-md border border-dashed border-border bg-card px-3 py-2 text-xs text-muted-foreground"
      data-testid="eaos-agents-empty"
    >
      No agents in this scope yet.
    </p>
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
          <dd className="text-base font-semibold text-foreground tabular-nums">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function AgentTable({
  rows,
  referenceNow,
}: {
  rows: readonly AgentRosterRow[];
  referenceNow: Date;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-card">
      <table className="w-full border-collapse text-left text-[13px]" data-testid="eaos-agents-table">
        <thead className="sticky top-0 z-10 border-b border-border bg-card text-[11px] uppercase tracking-wide text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">Agent</th>
            <th scope="col" className="px-3 py-2 font-medium">Role</th>
            <th scope="col" className="px-3 py-2 font-medium">Status</th>
            <th scope="col" className="px-3 py-2 font-medium">Runtime</th>
            <th scope="col" className="px-3 py-2 font-medium">Last seen</th>
            <th scope="col" className="px-3 py-2 font-medium">Budget</th>
            <th scope="col" className="px-3 py-2 font-medium text-right"><span className="sr-only">Open</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <AgentRow key={row.id} row={row} referenceNow={referenceNow} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AgentRow({ row, referenceNow }: { row: AgentRosterRow; referenceNow: Date }) {
  return (
    <tr
      className="border-b border-border last:border-b-0 hover:bg-accent/40"
      data-testid="eaos-agents-row"
      data-agent-id={row.id}
      data-agent-status={row.status}
    >
      <td className="px-3 py-2">
        <div className="flex items-center gap-2.5">
          <AgentAvatar
            size="md"
            subject={{ kind: "agent", agentId: row.id, name: row.name, role: row.role }}
            testId="eaos-agents-row-avatar"
          />
          <div className="min-w-0">
            <span
              className="block truncate font-medium text-foreground"
              data-testid="eaos-agents-row-name"
            >
              {redactSecretLikeText(row.name)}
            </span>
            {row.title ? (
              <span className="block truncate text-[11px] text-muted-foreground">
                {redactSecretLikeText(row.title)}
              </span>
            ) : null}
          </div>
        </div>
      </td>
      <td className="px-3 py-2 text-muted-foreground" data-testid="eaos-agents-row-role">
        {row.roleLabel}
      </td>
      <td className="px-3 py-2">
        <StatusBadge row={row} />
      </td>
      <td className="px-3 py-2">
        <span
          className="text-[12px] text-muted-foreground"
          data-testid="eaos-agents-row-adapter"
        >
          {humanizeAdapterType(row.adapterType)}
        </span>
      </td>
      <td className="px-3 py-2 text-muted-foreground tabular-nums" data-testid="eaos-agents-row-heartbeat">
        {relativeOrNever(row.lastHeartbeatAt, referenceNow)}
      </td>
      <td className="px-3 py-2 text-muted-foreground tabular-nums" data-testid="eaos-agents-row-budget">
        {formatUsdCents(row.spentMonthlyCents)} / {formatUsdCents(row.budgetMonthlyCents)}
      </td>
      <td className="px-3 py-2 text-right">
        <Link
          to={row.kernelRoute}
          className="text-[11px] font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          data-testid="eaos-agents-row-kernel-link"
        >
          Open →
        </Link>
      </td>
    </tr>
  );
}

function StatusBadge({ row }: { row: AgentRosterRow }) {
  const tone =
    row.status === "running"
      ? "border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-600 dark:bg-blue-950 dark:text-blue-100"
      : row.status === "active" || row.status === "idle"
        ? "border-green-300 bg-green-50 text-green-800 dark:border-green-600 dark:bg-green-950 dark:text-green-100"
        : row.status === "paused"
          ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-600 dark:bg-amber-950 dark:text-amber-100"
          : row.status === "error"
            ? "border-red-300 bg-red-50 text-red-800 dark:border-red-600 dark:bg-red-950 dark:text-red-100"
            : "border-zinc-300 bg-zinc-50 text-zinc-700 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200";
  return (
    <span
      className={
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium " +
        tone
      }
      title={statusTitle(row)}
    >
      {humanizeAgentStatus(row.status)}
      {row.status === "paused" && row.pauseReason ? (
        <ShieldAlert
          aria-hidden="true"
          className="h-3 w-3"
          data-testid="eaos-agents-row-pause-reason"
        />
      ) : null}
    </span>
  );
}

function statusTitle(row: AgentRosterRow): string {
  const base = humanizeAgentStatus(row.status);
  if (row.status === "paused" && row.pauseReason) {
    return `${base} — paused: ${row.pauseReason}.`;
  }
  return base;
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
