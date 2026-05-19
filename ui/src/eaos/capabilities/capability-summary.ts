// Pure helpers behind the LET-484 `/eaos/capabilities` zone. The capability
// posture for a company is currently derived from canonical Agent records
// (`agentsApi.list`) — each agent carries an adapter type, a runtime
// config, and a `capabilities` free-text string. That gives us a real,
// backend-backed "what runs where" view; full MCP / capability-apply
// plans are managed per-agent inside the kernel detail page (LET-357,
// LET-396) and remain the source of truth for desired/effective config.

import type { Agent } from "@paperclipai/shared";

export interface AdapterSummaryRow {
  readonly adapterType: string;
  readonly agentCount: number;
  readonly activeCount: number;
  readonly pausedCount: number;
}

export interface AgentCapabilityRow {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly adapterType: string;
  readonly capabilitiesSummary: string;
  readonly status: Agent["status"];
  readonly kernelRoute: string;
}

export interface CapabilityCounts {
  readonly totalAgents: number;
  readonly adapters: number;
  readonly withCapabilityNotes: number;
  readonly missingCapabilityNotes: number;
}

export function summarizeAdapters(agents: readonly Agent[]): readonly AdapterSummaryRow[] {
  const byAdapter = new Map<string, AdapterSummaryRow>();
  for (const agent of agents) {
    const key = agent.adapterType ?? "unknown";
    const existing = byAdapter.get(key) ?? {
      adapterType: key,
      agentCount: 0,
      activeCount: 0,
      pausedCount: 0,
    };
    byAdapter.set(key, {
      adapterType: key,
      agentCount: existing.agentCount + 1,
      activeCount:
        existing.activeCount
        + (agent.status === "active" || agent.status === "running" || agent.status === "idle" ? 1 : 0),
      pausedCount: existing.pausedCount + (agent.status === "paused" ? 1 : 0),
    });
  }
  return Array.from(byAdapter.values()).sort((a, b) => b.agentCount - a.agentCount);
}

export function buildAgentCapabilityRow(agent: Agent): AgentCapabilityRow {
  const capabilitiesSummary =
    typeof agent.capabilities === "string" && agent.capabilities.trim().length > 0
      ? agent.capabilities.trim().split(/\s*\n\s*/).slice(0, 2).join(" · ")
      : "—";
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role ?? "agent",
    adapterType: agent.adapterType ?? "unknown",
    capabilitiesSummary,
    status: agent.status,
    kernelRoute: `/agents/${agent.id}`,
  };
}

export function summarizeCapabilities(agents: readonly Agent[]): CapabilityCounts {
  let withNotes = 0;
  let withoutNotes = 0;
  const adapters = new Set<string>();
  for (const agent of agents) {
    if (typeof agent.capabilities === "string" && agent.capabilities.trim().length > 0) {
      withNotes += 1;
    } else {
      withoutNotes += 1;
    }
    if (agent.adapterType) adapters.add(agent.adapterType);
  }
  return {
    totalAgents: agents.length,
    adapters: adapters.size,
    withCapabilityNotes: withNotes,
    missingCapabilityNotes: withoutNotes,
  };
}
