import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/shared";
import {
  buildAgentConfigSnapshot,
  diffAgentConfigSnapshots,
} from "../commands/client/agent-snapshot.js";

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Platform Lead",
    urlKey: "platform-lead",
    role: "ceo",
    title: "CEO",
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: "Runs the company.",
    adapterType: "hermes_local",
    adapterConfig: {},
    runtimeConfig: {},
    defaultEnvironmentId: null,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: true },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-05-06T00:00:00.000Z"),
    updatedAt: new Date("2026-05-06T00:00:00.000Z"),
    ...overrides,
  };
}

describe("buildAgentConfigSnapshot", () => {
  it("sorts agents, resolves manager names, and redacts prompt bodies", () => {
    const manager = makeAgent({
      id: "manager-1",
      name: "ops-manager",
      urlKey: "ops-manager",
      role: "general",
      adapterConfig: {
        profile: "profile-ops-manager",
        promptTemplate: "private operating prompt that should not be exported",
      },
      metadata: {
        hermesProfile: "profile-ops-manager",
      },
    });
    const report = makeAgent({
      id: "report-1",
      name: "systems-steward",
      urlKey: "systems-steward",
      role: "devops",
      reportsTo: "manager-1",
      adapterConfig: {
        profile: "profile-systems-steward",
        promptTemplate: "another private prompt",
      },
      runtimeConfig: {
        heartbeat: {
          enabled: false,
          maxConcurrentRuns: 1,
        },
      },
      metadata: {
        hermesProfile: "profile-systems-steward",
      },
    });

    const snapshot = buildAgentConfigSnapshot({
      companyId: "company-1",
      generatedAt: "2026-05-06T01:02:03.000Z",
      agents: [report, manager],
    });

    expect(snapshot.agents.map((agent) => agent.name)).toEqual([
      "ops-manager",
      "systems-steward",
    ]);
    expect(snapshot.agents[1]?.reportsToName).toBe("ops-manager");
    expect(snapshot.agents[0]?.adapterConfig.safeValues).toEqual({
      profile: "profile-ops-manager",
    });
    expect(snapshot.agents[1]?.runtimeConfig.safeValues).toEqual({
      "heartbeat.enabled": false,
      "heartbeat.maxConcurrentRuns": 1,
    });
    expect(JSON.stringify(snapshot)).not.toContain("private operating prompt");
    expect(snapshot.agents[0]?.adapterConfig.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("diffAgentConfigSnapshots", () => {
  it("reports missing, unexpected, and changed agents by name", () => {
    const expected = buildAgentConfigSnapshot({
      companyId: "company-1",
      generatedAt: "2026-05-06T01:02:03.000Z",
      agents: [
        makeAgent({
          id: "agent-1",
          name: "fixer",
          role: "engineer",
          adapterType: "codex_local",
        }),
        makeAgent({
          id: "agent-2",
          name: "watcher",
          role: "qa",
          adapterType: "codex_local",
        }),
      ],
    });
    const actual = buildAgentConfigSnapshot({
      companyId: "company-1",
      generatedAt: "2026-05-06T02:03:04.000Z",
      agents: [
        makeAgent({
          id: "agent-1",
          name: "fixer",
          role: "engineer",
          adapterType: "hermes_local",
        }),
        makeAgent({
          id: "agent-3",
          name: "release-engineer",
          role: "devops",
          adapterType: "codex_local",
        }),
      ],
    });

    const diff = diffAgentConfigSnapshots(expected, actual);

    expect(diff.status).toBe("drift");
    expect(diff.missingAgents).toEqual(["watcher"]);
    expect(diff.unexpectedAgents).toEqual(["release-engineer"]);
    expect(diff.changedAgents).toEqual([
      {
        name: "fixer",
        fields: ["adapterType"],
      },
    ]);
  });
});
