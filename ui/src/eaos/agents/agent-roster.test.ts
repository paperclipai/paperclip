import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/shared";

import {
  buildAgentRosterRow,
  groupRosterByRole,
  summarizeAgents,
  AGENT_ROSTER_TEST_HELPERS,
} from "./agent-roster";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: overrides.id ?? "agent-1",
    companyId: "company-1",
    name: overrides.name ?? "Agent",
    urlKey: overrides.urlKey ?? "agent",
    role: overrides.role ?? "engineer",
    title: overrides.title ?? null,
    icon: null,
    status: overrides.status ?? "active",
    reportsTo: null,
    capabilities: null,
    adapterType: overrides.adapterType ?? "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: overrides.budgetMonthlyCents ?? 0,
    spentMonthlyCents: overrides.spentMonthlyCents ?? 0,
    pauseReason: overrides.pauseReason ?? null,
    pausedAt: overrides.pausedAt ?? null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: overrides.lastHeartbeatAt ?? null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as Agent;
}

describe("agent-roster.summarizeAgents", () => {
  it("returns zeroed counts for an empty roster", () => {
    expect(summarizeAgents([])).toEqual({
      total: 0,
      active: 0,
      running: 0,
      idle: 0,
      paused: 0,
      error: 0,
      pendingApproval: 0,
      terminated: 0,
    });
  });

  it("counts active = active + idle + running", () => {
    const counts = summarizeAgents([
      makeAgent({ id: "a", status: "active" }),
      makeAgent({ id: "b", status: "idle" }),
      makeAgent({ id: "c", status: "running" }),
      makeAgent({ id: "d", status: "paused" }),
      makeAgent({ id: "e", status: "error" }),
      makeAgent({ id: "f", status: "pending_approval" }),
      makeAgent({ id: "g", status: "terminated" }),
    ]);
    expect(counts.total).toBe(7);
    expect(counts.active).toBe(3);
    expect(counts.running).toBe(1);
    expect(counts.idle).toBe(1);
    expect(counts.paused).toBe(1);
    expect(counts.error).toBe(1);
    expect(counts.pendingApproval).toBe(1);
    expect(counts.terminated).toBe(1);
  });
});

describe("agent-roster.buildAgentRosterRow", () => {
  it("maps backend status to LET-167 chip vocabulary", () => {
    expect(buildAgentRosterRow(makeAgent({ status: "running" })).statusChipLabel).toBe("LIVE");
    expect(buildAgentRosterRow(makeAgent({ status: "active" })).statusChipLabel).toBe("BACKEND-BACKED");
    expect(buildAgentRosterRow(makeAgent({ status: "idle" })).statusChipLabel).toBe("BACKEND-BACKED");
    expect(buildAgentRosterRow(makeAgent({ status: "pending_approval" })).statusChipLabel).toBe(
      "APPROVAL REQUIRED",
    );
    expect(buildAgentRosterRow(makeAgent({ status: "paused" })).statusChipLabel).toBe("PREVIEW");
    expect(buildAgentRosterRow(makeAgent({ status: "error" })).statusChipLabel).toBe("FAILED");
    expect(buildAgentRosterRow(makeAgent({ status: "terminated" })).statusChipLabel).toBe("DEMO");
  });

  it("routes the kernel/admin link to the canonical agent detail page", () => {
    const row = buildAgentRosterRow(makeAgent({ id: "agent-x" }));
    expect(row.kernelRoute).toBe("/agents/agent-x");
  });

  it("parses string heartbeats and pausedAt into Date instances", () => {
    const iso = "2026-05-19T10:00:00.000Z";
    const row = buildAgentRosterRow(
      makeAgent({
        lastHeartbeatAt: iso as unknown as Agent["lastHeartbeatAt"],
        pausedAt: iso as unknown as Agent["pausedAt"],
      }),
    );
    expect(row.lastHeartbeatAt?.toISOString()).toBe(iso);
    expect(row.pausedAt?.toISOString()).toBe(iso);
  });
});

describe("agent-roster.groupRosterByRole", () => {
  it("groups by role in the leadership-first order and sorts by name within a group", () => {
    const rows = [
      buildAgentRosterRow(makeAgent({ id: "1", role: "engineer", name: "Zelda" })),
      buildAgentRosterRow(makeAgent({ id: "2", role: "ceo", name: "Andrii" })),
      buildAgentRosterRow(makeAgent({ id: "3", role: "engineer", name: "Alex" })),
      buildAgentRosterRow(makeAgent({ id: "4", role: "cto", name: "Claude" })),
    ];
    const groups = groupRosterByRole(rows);
    expect(groups.map((g) => g.role)).toEqual(["ceo", "cto", "engineer"]);
    expect(groups[2]!.rows.map((row) => row.name)).toEqual(["Alex", "Zelda"]);
  });

  it("pushes terminated rows to the bottom of their role group", () => {
    const rows = [
      buildAgentRosterRow(makeAgent({ id: "term-a", role: "engineer", name: "AAA", status: "terminated" })),
      buildAgentRosterRow(makeAgent({ id: "active-z", role: "engineer", name: "ZZZ", status: "active" })),
    ];
    const groups = groupRosterByRole(rows);
    expect(groups[0]!.rows.map((row) => row.name)).toEqual(["ZZZ", "AAA"]);
  });
});

describe("agent-roster ROLE_ORDER", () => {
  it("places leadership before execution roles", () => {
    const { ROLE_ORDER } = AGENT_ROSTER_TEST_HELPERS;
    expect(ROLE_ORDER.indexOf("ceo")).toBeLessThan(ROLE_ORDER.indexOf("engineer"));
    expect(ROLE_ORDER.indexOf("cto")).toBeLessThan(ROLE_ORDER.indexOf("designer"));
    expect(ROLE_ORDER.indexOf("security")).toBeLessThan(ROLE_ORDER.indexOf("general"));
  });
});
