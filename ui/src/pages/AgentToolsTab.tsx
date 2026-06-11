import { useMemo } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import { HelpCircle } from "lucide-react";
import type {
  AgentDetail as AgentDetailRecord,
  ToolCatalogEntry,
  ToolPolicy,
} from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { queryKeys } from "../lib/queryKeys";
import { toolsApi } from "../api/tools";
import { EnforcementBanner } from "../components/EnforcementBanner";
import {
  RiskBadge,
  CapabilityBadges,
  LoadingState as ToolsLoadingState,
  ErrorState as ToolsErrorState,
} from "./tools/shared";

/** Normalize a selector value (string or string[]) into a flat string list. */
function selectorStringList(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  }
  return [];
}

/**
 * A policy governs this agent's allow list when it either explicitly names the
 * agent, or carries no agent/actor restriction that would exclude agents. This
 * mirrors how the tool gateway evaluates selectors server-side.
 */
export function policyGovernsAgent(policy: ToolPolicy, agentId: string): boolean {
  const selectors = (policy.selectors ?? {}) as Record<string, unknown>;
  const agentIds = [
    ...selectorStringList(selectors.agentId),
    ...selectorStringList(selectors.agentIds),
  ];
  if (agentIds.length > 0) return agentIds.includes(agentId);
  const actorTypes = [
    ...selectorStringList(selectors.actorType),
    ...selectorStringList(selectors.actorTypes),
  ];
  if (actorTypes.length > 0 && !actorTypes.includes("agent")) return false;
  return true;
}

const POLICY_EFFECT_LABEL: Record<string, string> = {
  allow: "allow",
  block: "block",
  deny: "deny",
  require_approval: "require approval",
  redact: "redact",
  rate_limit: "rate limit",
};

const DENIED_TOOLS_DISPLAY_LIMIT = 30;

/**
 * Agent detail · Tools tab (PAP-10788, surface 09 of the PAP-10771 v2 spec).
 *
 * Communicates the agent's *server-resolved* tool access: the effective-access
 * banner makes clear the list is gateway-authoritative (the prompt can narrow
 * it but never expand it), and the "Why these tools?" panel explains how it was
 * derived — bound profile, governing policies, and the suppressed (denied)
 * catalog tools the agent could name but would be blocked on.
 */
export function AgentToolsTab({ agent, companyId }: { agent: AgentDetailRecord; companyId: string }) {
  const effective = useQuery({
    queryKey: queryKeys.tools.effectiveProfilesForAgent(companyId, agent.id),
    queryFn: () => toolsApi.getEffectiveProfilesForAgent(companyId, agent.id),
  });

  const connectionsQuery = useQuery({
    queryKey: queryKeys.tools.connections(companyId),
    queryFn: () => toolsApi.listConnections(companyId),
  });

  const policiesQuery = useQuery({
    queryKey: queryKeys.tools.policies(companyId),
    queryFn: () => toolsApi.listPolicies(companyId),
  });

  const connectionList = connectionsQuery.data?.connections ?? [];

  // The effective endpoint returns the *allowed* slice of the catalog. To show
  // "Denied tools (suppressed)" we need the full company catalog, which is only
  // exposed per-connection — same aggregation the Applications tab uses.
  const catalogQueries = useQueries({
    queries: connectionList.map((connection) => ({
      queryKey: queryKeys.tools.catalog(connection.id),
      queryFn: () => toolsApi.listCatalog(connection.id),
      staleTime: 60_000,
    })),
  });

  const connectionNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const connection of connectionList) map.set(connection.id, connection.name);
    return map;
  }, [connectionList]);

  const allowedTools = useMemo(
    () =>
      [...(effective.data?.allowedTools ?? [])].sort((a, b) =>
        a.toolName.localeCompare(b.toolName),
      ),
    [effective.data?.allowedTools],
  );

  const catalogStamp = catalogQueries.map((q) => q.dataUpdatedAt).join(",");
  const deniedTools = useMemo(() => {
    const allowedIds = new Set((effective.data?.allowedTools ?? []).map((tool) => tool.id));
    const seen = new Set<string>();
    const denied: ToolCatalogEntry[] = [];
    for (const result of catalogQueries) {
      for (const entry of result.data?.catalog ?? []) {
        if (entry.status !== "active") continue;
        if (allowedIds.has(entry.id) || seen.has(entry.id)) continue;
        seen.add(entry.id);
        denied.push(entry);
      }
    }
    return denied.sort((a, b) => a.toolName.localeCompare(b.toolName));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effective.data?.allowedTools, catalogStamp]);

  const governingPolicies = useMemo(() => {
    const policies = policiesQuery.data?.policies ?? [];
    return policies
      .map((policy, index) => ({ policy, order: index + 1 }))
      .filter(({ policy }) => policy.enabled && policyGovernsAgent(policy, agent.id));
  }, [policiesQuery.data?.policies, agent.id]);

  const profiles = effective.data?.profiles ?? [];
  const bindings = effective.data?.bindings ?? [];
  const catalogLoading = catalogQueries.some((q) => q.isLoading);

  if (effective.isLoading) return <ToolsLoadingState label="Resolving effective access…" />;
  if (effective.error) {
    return <ToolsErrorState error={effective.error} onRetry={() => effective.refetch()} />;
  }

  const policiesHref = "/apps/advanced/policies";
  const profilesHref = "/apps/advanced/profiles";

  return (
    <div className="space-y-4">
      <EnforcementBanner
        tone="info"
        title="Effective access — server resolved."
        body={
          <>
            This is exactly the tool set the gateway will accept for{" "}
            <span className="font-medium">{agent.name}</span>. Profile and policy edits are
            reflected within ~5 seconds. The agent's prompt can narrow this list but{" "}
            <span className="font-medium">cannot expand it</span> — everything else is denied by
            default.
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Allowed tools table */}
        <div className="lg:col-span-2">
          <div className="rounded-lg border border-border">
            <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
              <h3 className="text-sm font-semibold text-foreground">Allowed tools</h3>
              <span className="text-xs text-muted-foreground tabular-nums">
                {allowedTools.length} {allowedTools.length === 1 ? "tool" : "tools"}
              </span>
            </div>
            {allowedTools.length === 0 ? (
              <p className="px-3 py-6 text-sm text-muted-foreground">
                No tools are allowed for this agent. Bind a tool profile to grant access.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Tool</th>
                    <th className="px-3 py-2 font-medium">Capability</th>
                    <th className="px-3 py-2 font-medium">Risk</th>
                    <th className="px-3 py-2 font-medium">Source</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {allowedTools.map((tool) => (
                    <tr key={tool.id} className="align-top">
                      <td className="px-3 py-2">
                        <div className="font-mono text-xs text-foreground">{tool.toolName}</div>
                        {tool.title ? (
                          <div className="text-[11px] text-muted-foreground">{tool.title}</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        <CapabilityBadges
                          isReadOnly={tool.isReadOnly}
                          isWrite={tool.isWrite}
                          isDestructive={tool.isDestructive}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <RiskBadge risk={tool.riskLevel} />
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {connectionNameById.get(tool.connectionId) ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Why these tools? side panel */}
        <aside className="space-y-4">
          <div className="rounded-lg border border-border bg-background/60 p-3">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
              <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" />
              Why these tools?
            </h3>

            {/* Bound profile(s) */}
            <div className="mt-3 space-y-1.5">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Bound profile{profiles.length === 1 ? "" : "s"}
              </div>
              {profiles.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No active profile is bound — the agent has no allowed tools.
                </p>
              ) : (
                profiles.map((profile) => {
                  const agentBinding = bindings.find(
                    (b) => b.profileId === profile.id && b.targetType === "agent",
                  );
                  return (
                    <div key={profile.id} className="rounded-md border border-border/70 px-2.5 py-2">
                      <Link
                        to={profilesHref}
                        className="text-xs font-medium text-primary hover:underline"
                      >
                        {profile.name}
                      </Link>
                      <div className="text-[11px] text-muted-foreground">
                        default {profile.defaultAction} ·{" "}
                        {agentBinding ? "bound to agent" : "company default"}
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Policies mutating the allow list */}
            <div className="mt-3 space-y-1.5">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Active policies
              </div>
              {policiesQuery.isLoading ? (
                <p className="text-xs text-muted-foreground">Loading policies…</p>
              ) : governingPolicies.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No enabled policy currently mutates this agent's allow list.
                </p>
              ) : (
                governingPolicies.map(({ policy, order }) => (
                  <div key={policy.id} className="rounded-md border border-border/70 px-2.5 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <Link
                        to={policiesHref}
                        className="truncate text-xs font-medium text-primary hover:underline"
                        title={`Policy #${order}: ${policy.name}`}
                      >
                        #{order} {policy.name}
                      </Link>
                      <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                        {POLICY_EFFECT_LABEL[policy.policyType] ?? policy.policyType}
                      </span>
                    </div>
                    {policy.description ? (
                      <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                        {policy.description}
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </div>

            {/* Denied tools (suppressed) */}
            <div className="mt-3 space-y-1.5">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Denied tools (suppressed)
              </div>
              {catalogLoading ? (
                <p className="text-xs text-muted-foreground">Resolving catalog…</p>
              ) : deniedTools.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No suppressed tools — every catalog tool this agent could name is allowed.
                </p>
              ) : (
                <>
                  <p className="text-[11px] text-muted-foreground">
                    Tools the agent could name but the gateway would block:
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {deniedTools.slice(0, DENIED_TOOLS_DISPLAY_LIMIT).map((tool) => (
                      <span
                        key={tool.id}
                        className="inline-flex items-center gap-1 rounded border border-border/70 bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                        title={connectionNameById.get(tool.connectionId) ?? undefined}
                      >
                        {tool.toolName}
                      </span>
                    ))}
                  </div>
                  {deniedTools.length > DENIED_TOOLS_DISPLAY_LIMIT ? (
                    <p className="text-[11px] text-muted-foreground">
                      +{deniedTools.length - DENIED_TOOLS_DISPLAY_LIMIT} more
                    </p>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
