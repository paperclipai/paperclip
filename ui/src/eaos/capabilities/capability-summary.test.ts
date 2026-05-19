import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/shared";

import {
  buildAgentCapabilityRow,
  summarizeAdapters,
  summarizeCapabilities,
} from "./capability-summary";

function makeAgent(overrides: Partial<Agent> & { id: string }): Agent {
  return {
    id: overrides.id,
    companyId: "company-1",
    name: overrides.name ?? "Agent",
    urlKey: overrides.urlKey ?? overrides.id,
    role: overrides.role ?? "engineer",
    title: overrides.title ?? null,
    icon: null,
    status: overrides.status ?? "active",
    reportsTo: null,
    capabilities: overrides.capabilities ?? null,
    adapterType: overrides.adapterType ?? "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Agent;
}

describe("summarizeAdapters", () => {
  it("counts agents by adapter type and splits active vs paused", () => {
    const rows = summarizeAdapters([
      makeAgent({ id: "1", adapterType: "claude_local", status: "active" }),
      makeAgent({ id: "2", adapterType: "claude_local", status: "running" }),
      makeAgent({ id: "3", adapterType: "claude_local", status: "paused" }),
      makeAgent({ id: "4", adapterType: "openai_remote", status: "active" }),
    ]);
    expect(rows.length).toBe(2);
    const claude = rows.find((row) => row.adapterType === "claude_local")!;
    expect(claude.agentCount).toBe(3);
    expect(claude.activeCount).toBe(2);
    expect(claude.pausedCount).toBe(1);
    // Sort: claude_local (3 agents) appears before openai_remote (1 agent).
    expect(rows[0].adapterType).toBe("claude_local");
  });
});

describe("buildAgentCapabilityRow", () => {
  it("returns an em-dash when the agent has no capability blob", () => {
    const row = buildAgentCapabilityRow(makeAgent({ id: "1", capabilities: null }));
    expect(row.capabilitiesSummary).toBe("—");
  });

  it("collapses multi-line capability blobs into the first two lines", () => {
    const row = buildAgentCapabilityRow(
      makeAgent({
        id: "2",
        capabilities: "Frontend QA\nVisual review\nAccessibility checks",
      }),
    );
    expect(row.capabilitiesSummary).toBe("Frontend QA · Visual review");
  });
});

describe("summarizeCapabilities", () => {
  it("counts agents, distinct adapters, and capability-note presence", () => {
    const counts = summarizeCapabilities([
      makeAgent({ id: "1", adapterType: "claude_local", capabilities: "Some notes" }),
      makeAgent({ id: "2", adapterType: "claude_local", capabilities: null }),
      makeAgent({ id: "3", adapterType: "openai_remote", capabilities: "" }),
      makeAgent({ id: "4", adapterType: "openai_remote", capabilities: "More notes" }),
    ]);
    expect(counts).toEqual({
      totalAgents: 4,
      adapters: 2,
      withCapabilityNotes: 2,
      missingCapabilityNotes: 2,
    });
  });
});
