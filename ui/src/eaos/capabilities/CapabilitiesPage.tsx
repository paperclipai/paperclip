// LET-484 working-product slice — read-only `/eaos/capabilities` zone.
//
// Capability posture for a company is derived from canonical Agent records:
//   - Adapter types in use across the roster (`adapterType`).
//   - Per-agent capability summary (`agent.capabilities` free-text blob).
//   - Per-agent status / role / kernel route for deeper drill-in.
//
// Truthful gap labels:
//   - MCP server registry / capability packages aren't exposed company-wide
//     yet. The per-agent capability-apply plans (LET-357 / LET-396) live
//     inside the kernel agent detail page.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Boxes, Cpu, Wrench } from "lucide-react";
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
  buildAgentCapabilityRow,
  summarizeAdapters,
  summarizeCapabilities,
  type AdapterSummaryRow,
  type AgentCapabilityRow,
  type CapabilityCounts,
} from "./capability-summary";

export function CapabilitiesPage() {
  const { selectedCompanyId, selectedCompany } = useCompany();

  const agentsQuery = useQuery({
    queryKey: selectedCompanyId
      ? [...queryKeys.agents.list(selectedCompanyId), "eaos-capabilities"]
      : ["agents", "__no-company__", "eaos-capabilities"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const adapterRows = useMemo<readonly AdapterSummaryRow[]>(
    () => summarizeAdapters(agentsQuery.data ?? []),
    [agentsQuery.data],
  );
  const agentRows = useMemo<readonly AgentCapabilityRow[]>(
    () => (agentsQuery.data ?? []).map(buildAgentCapabilityRow),
    [agentsQuery.data],
  );
  const counts = useMemo<CapabilityCounts>(
    () => summarizeCapabilities(agentsQuery.data ?? []),
    [agentsQuery.data],
  );

  const isLoading = Boolean(selectedCompanyId) && agentsQuery.isLoading;
  const isError = Boolean(selectedCompanyId) && agentsQuery.isError;
  const hasData = !isLoading && !isError && agentsQuery.isSuccess;
  const dataConnected = hasData;

  return (
    <section
      aria-labelledby="eaos-capabilities-title"
      className="flex flex-col gap-5"
      data-testid="eaos-capabilities-page"
      data-eaos-data-connected={dataConnected ? "true" : "false"}
    >
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2" data-testid="eaos-capabilities-posture">
          <EaosStateChip label={SHELL_POSTURE_LABEL} prefix={SHELL_POSTURE_PREFIX} />
          {dataConnected ? (
            <EaosStateChip
              label="BACKEND-BACKED"
              prefix="Roster"
              title="Capability summary derived from canonical Agent records via /api/companies/:companyId/agents"
            />
          ) : (
            <EaosStateChip label={NOT_CONNECTED_DATA_LABEL} prefix={NOT_CONNECTED_DATA_PREFIX} />
          )}
          <EaosStateChip
            label="PREVIEW"
            prefix="MCP-registry"
            title="Company-wide MCP server registry is not wired in this slice. Backend gap: GET /api/companies/:companyId/capabilities — pending."
          />
          <span
            className="text-[11px] uppercase tracking-wide text-muted-foreground"
            data-testid="eaos-capabilities-posture-note"
          >
            {dataConnected
              ? `Live read · ${selectedCompany?.name ? redactSecretLikeText(selectedCompany.name) : "current company scope"}`
              : NOT_CONNECTED_DATA_NOTE}
          </span>
        </div>
        <div className="flex flex-col gap-1.5 sm:flex-row sm:items-end sm:justify-between sm:gap-3">
          <div className="flex flex-col gap-1">
            <h1
              id="eaos-capabilities-title"
              className="text-2xl font-semibold tracking-tight text-foreground"
              data-testid="eaos-capabilities-title"
            >
              Capabilities / MCP
            </h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Capability posture for the current company scope derived from canonical Agent
              records. Adapter mix, per-agent capability notes, and links into the kernel
              capability-apply detail. Desired/effective MCP server config stays inside the
              kernel agent detail (LET-357 / LET-396 capability-apply).
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
      ) : (agentsQuery.data?.length ?? 0) === 0 ? (
        <EmptyState />
      ) : (
        <>
          <SummaryStrip counts={counts} />
          <AdaptersSection rows={adapterRows} />
          <CapabilitiesPerAgentSection rows={agentRows} />
        </>
      )}

      <McpGapSection />
    </section>
  );
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Failed to load capability posture.";
}

function NoCompanyState() {
  return (
    <div
      role="status"
      className="rounded-md border border-dashed border-border bg-card p-4 text-sm text-muted-foreground"
      data-testid="eaos-capabilities-no-company"
    >
      Select a company scope from the top bar to load the capability posture.
    </div>
  );
}

function LoadingState() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground"
      data-testid="eaos-capabilities-loading"
    >
      Loading capability posture from canonical Agent records…
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100"
      data-testid="eaos-capabilities-error"
    >
      <p className="font-medium">Could not load capabilities.</p>
      <p className="mt-1 text-xs">{redactSecretLikeText(message)}</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div
      role="status"
      className="rounded-md border border-dashed border-border bg-card p-4 text-sm text-muted-foreground"
      data-testid="eaos-capabilities-empty"
    >
      No agents are visible in the current company scope yet — capability posture is empty.
    </div>
  );
}

function SummaryStrip({ counts }: { counts: CapabilityCounts }) {
  const items: Array<{ id: string; label: string; value: number }> = [
    { id: "agents", label: "Agents", value: counts.totalAgents },
    { id: "adapters", label: "Adapters", value: counts.adapters },
    { id: "with-notes", label: "With capability notes", value: counts.withCapabilityNotes },
    { id: "missing-notes", label: "Missing notes", value: counts.missingCapabilityNotes },
  ];
  return (
    <dl
      data-testid="eaos-capabilities-summary"
      className="grid grid-cols-2 gap-2 rounded-md border border-border bg-card p-3 sm:grid-cols-4"
    >
      {items.map((item) => (
        <div
          key={item.id}
          data-testid={`eaos-capabilities-summary-${item.id}`}
          className="flex flex-col gap-0.5"
        >
          <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{item.label}</dt>
          <dd className="text-lg font-semibold text-foreground tabular-nums">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function AdaptersSection({ rows }: { rows: readonly AdapterSummaryRow[] }) {
  return (
    <section
      aria-label="Adapters in use"
      className="flex flex-col gap-2"
      data-testid="eaos-capabilities-adapters"
    >
      <header className="flex items-center gap-2">
        <Boxes aria-hidden="true" className="h-4 w-4 text-foreground" />
        <h2 className="text-sm font-semibold text-foreground">
          Adapters in use{" "}
          <span className="text-xs font-normal text-muted-foreground">({rows.length})</span>
        </h2>
      </header>
      <ul
        className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3"
        data-testid="eaos-capabilities-adapters-rows"
      >
        {rows.map((row) => (
          <li
            key={row.adapterType}
            className="flex flex-col gap-2 rounded-md border border-border bg-card p-3"
            data-testid="eaos-capabilities-adapter-row"
            data-adapter-type={row.adapterType}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-foreground">{row.adapterType}</span>
              <EaosStateChip
                label="BACKEND-BACKED"
                prefix="Adapter"
                title="Adapter mix derived from live agentsApi roster."
              />
            </div>
            <dl className="grid grid-cols-3 gap-2 text-[11px] text-muted-foreground">
              <div className="flex flex-col" data-testid="eaos-capabilities-adapter-agents">
                <dt className="uppercase tracking-wide">Agents</dt>
                <dd className="text-foreground tabular-nums">{row.agentCount}</dd>
              </div>
              <div className="flex flex-col" data-testid="eaos-capabilities-adapter-active">
                <dt className="uppercase tracking-wide">Active</dt>
                <dd className="text-foreground tabular-nums">{row.activeCount}</dd>
              </div>
              <div className="flex flex-col" data-testid="eaos-capabilities-adapter-paused">
                <dt className="uppercase tracking-wide">Paused</dt>
                <dd className="text-foreground tabular-nums">{row.pausedCount}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CapabilitiesPerAgentSection({ rows }: { rows: readonly AgentCapabilityRow[] }) {
  return (
    <section
      aria-label="Capabilities per agent"
      className="flex flex-col gap-2"
      data-testid="eaos-capabilities-agents"
    >
      <header className="flex items-center gap-2">
        <Cpu aria-hidden="true" className="h-4 w-4 text-foreground" />
        <h2 className="text-sm font-semibold text-foreground">
          Capabilities per agent{" "}
          <span className="text-xs font-normal text-muted-foreground">({rows.length})</span>
        </h2>
      </header>
      <ul
        className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3"
        data-testid="eaos-capabilities-agents-rows"
      >
        {rows.map((row) => (
          <li
            key={row.id}
            className="flex flex-col gap-2 rounded-md border border-border bg-card p-3"
            data-testid="eaos-capabilities-agent-row"
            data-agent-id={row.id}
          >
            <div className="flex flex-wrap items-center gap-2">
              <EaosStateChip
                label="BACKEND-BACKED"
                prefix="Capability"
                title="Capability notes derived from live Agent record."
              />
              <span className="rounded-md border border-dashed border-border bg-background px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {row.adapterType}
              </span>
            </div>
            <p className="text-sm font-medium text-foreground" data-testid="eaos-capabilities-agent-name">
              {redactSecretLikeText(row.name)}
            </p>
            <p className="text-xs text-muted-foreground" data-testid="eaos-capabilities-agent-role">
              {row.role}
            </p>
            <p
              className="text-[11px] text-muted-foreground line-clamp-3"
              data-testid="eaos-capabilities-agent-summary"
            >
              {redactSecretLikeText(row.capabilitiesSummary)}
            </p>
            <Link
              to={row.kernelRoute}
              className="font-medium text-xs text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              data-testid="eaos-capabilities-agent-link"
            >
              Open capability detail in Kernel/Admin →
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function McpGapSection() {
  return (
    <section
      aria-label="MCP server registry"
      className="flex flex-col gap-2 rounded-md border border-dashed border-border bg-card p-3"
      data-testid="eaos-capabilities-mcp-gap"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Wrench aria-hidden="true" className="h-4 w-4 text-foreground" />
          <h2 className="text-sm font-semibold text-foreground">MCP server registry</h2>
        </div>
        <EaosStateChip label={NOT_CONNECTED_DATA_LABEL} prefix={NOT_CONNECTED_DATA_PREFIX} />
      </div>
      <p className="text-xs text-muted-foreground">
        Temporary gap — a company-wide MCP server registry endpoint does not exist yet.
      </p>
      <p className="text-[11px] text-muted-foreground">
        Backend path pending: <code>GET /api/companies/:companyId/capabilities</code>. Per-agent
        capability-apply plans (desired/effective config) already live inside the kernel agent
        detail page (LET-357 / LET-396).
      </p>
    </section>
  );
}
