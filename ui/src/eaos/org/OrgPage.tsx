// LET-503 (LET-502 contract §5) — first-class `/eaos/org` route. Until the
// dedicated team/graph backend lands, the Org page is a calm role-grouped
// table derived from `agentsApi.list`. The visual is operational (role,
// active count, running count, total count) rather than decorative
// avatars-only. Missing graph relationships are named at the bottom as a
// truthful gap, per contract §5.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "@/api/agents";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { redactSecretLikeText } from "../secret-redact";
import {
  buildAgentRosterRow,
  groupRosterByRole,
  type AgentRosterGroup,
  type AgentRosterRow,
} from "../agents/agent-roster";

export function OrgPage() {
  const { selectedCompanyId, selectedCompany } = useCompany();

  const agentsQuery = useQuery({
    queryKey: selectedCompanyId
      ? [...queryKeys.agents.list(selectedCompanyId), "eaos-org"]
      : ["agents", "__no-company__", "eaos-org"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const rows = useMemo<AgentRosterRow[]>(
    () => (agentsQuery.data ?? []).map(buildAgentRosterRow),
    [agentsQuery.data],
  );
  const groups = useMemo(() => groupRosterByRole(rows), [rows]);

  const isLoading = Boolean(selectedCompanyId) && agentsQuery.isLoading;
  const isError = Boolean(selectedCompanyId) && agentsQuery.isError;
  const dataConnected = !isLoading && !isError && agentsQuery.isSuccess;

  return (
    <section
      aria-labelledby="eaos-org-title"
      data-testid="eaos-org-page"
      data-eaos-data-connected={dataConnected ? "true" : "false"}
      className="flex min-h-0 flex-1 flex-col gap-4"
    >
      <header className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between sm:gap-3">
        <h1
          id="eaos-org-title"
          className="text-xl font-semibold tracking-tight text-foreground"
          data-testid="eaos-org-title"
        >
          Org
        </h1>
        {selectedCompany ? (
          <span className="text-xs text-muted-foreground">
            {redactSecretLikeText(selectedCompany.name)}
          </span>
        ) : null}
      </header>

      {!selectedCompanyId ? (
        <ContextNote
          testId="eaos-org-no-company"
          body="Select a company scope in the top bar to load the org."
        />
      ) : isLoading ? (
        <ContextNote testId="eaos-org-loading" body="Loading org structure…" />
      ) : isError ? (
        <ContextNote
          testId="eaos-org-error"
          tone="error"
          body="Could not load the org. Try refreshing."
        />
      ) : groups.length === 0 ? (
        <ContextNote
          testId="eaos-org-empty"
          body="No agents in this scope yet. The org will appear here once agents are onboarded."
        />
      ) : (
        <OrgTable groups={groups} />
      )}

      <GapNote />
    </section>
  );
}

function OrgTable({ groups }: { groups: readonly AgentRosterGroup[] }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-card">
      <table className="w-full border-collapse text-left text-[13px]" data-testid="eaos-org-table">
        <thead className="sticky top-0 z-10 border-b border-border bg-card text-[11px] uppercase tracking-wide text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">Team / role</th>
            <th scope="col" className="px-3 py-2 font-medium">Agents</th>
            <th scope="col" className="px-3 py-2 font-medium">Active</th>
            <th scope="col" className="px-3 py-2 font-medium">Running</th>
            <th scope="col" className="px-3 py-2 font-medium">Members</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => {
            const active = group.rows.filter((row) =>
              row.status === "active" || row.status === "idle" || row.status === "running",
            ).length;
            const running = group.rows.filter((row) => row.status === "running").length;
            return (
              <tr
                key={group.role}
                className="border-b border-border last:border-b-0 align-top hover:bg-accent/40"
                data-testid={`eaos-org-row-${group.role}`}
              >
                <td className="px-3 py-2 font-medium text-foreground">{group.roleLabel}</td>
                <td className="px-3 py-2 tabular-nums text-foreground">{group.rows.length}</td>
                <td className="px-3 py-2 tabular-nums text-foreground">{active}</td>
                <td className="px-3 py-2 tabular-nums text-foreground">{running}</td>
                <td className="px-3 py-2">
                  <ul className="flex flex-wrap gap-1">
                    {group.rows.map((row) => (
                      <li key={row.id}>
                        <Link
                          to={row.kernelRoute}
                          className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5 text-[11px] text-foreground underline-offset-2 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                          title={row.title ? redactSecretLikeText(row.title) : row.roleLabel}
                          data-testid={`eaos-org-member-${row.id}`}
                        >
                          {redactSecretLikeText(row.name)}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function GapNote() {
  return (
    <p
      data-testid="eaos-org-gap-note"
      className="text-[11px] text-muted-foreground"
    >
      Team hierarchy and reporting lines are derived from agent roles. A dedicated
      team / reporting-graph endpoint is not wired yet.
    </p>
  );
}

function ContextNote({
  body,
  tone = "muted",
  testId,
}: {
  body: string;
  tone?: "muted" | "error";
  testId?: string;
}) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      data-testid={testId}
      className={
        "rounded-md border px-3 py-2 text-xs " +
        (tone === "error"
          ? "border-red-200 bg-red-50 text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100"
          : "border-dashed border-border bg-card text-muted-foreground")
      }
    >
      {body}
    </p>
  );
}
