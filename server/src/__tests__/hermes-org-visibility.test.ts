import { describe, expect, it } from "vitest";
import { buildHermesOrgVisibility } from "../routes/hermes-org-visibility.js";

describe("Hermes org visibility summary", () => {
  it("groups Hermes lead agents by division and pod, summarizes bridge state, and keeps reviews visible", () => {
    const summary = buildHermesOrgVisibility({
      agents: [
        {
          id: "agent-coo",
          name: "COO / Mission Control Lead",
          title: "COO / Mission Control Lead",
          status: "active",
          adapterType: "http",
          lastHeartbeatAt: new Date("2026-06-01T10:00:00.000Z"),
          metadata: {
            hermesOrg: "full-lead-org",
            profile: "leadcoo",
            division: "Executive / Coordination",
            charter: "Own the operating cadence.",
            cadence: "daily",
            skills: ["kanban-orchestrator"],
            review: ["Audit Lead"],
            bridgeUrl: "http://hermes-paperclip-org-bridge:8650/invoke",
          },
        },
        {
          id: "agent-research",
          name: "Research Lead",
          title: "Research Lead",
          status: "active",
          adapterType: "http",
          lastHeartbeatAt: null,
          metadata: {
            hermesOrg: "full-lead-org",
            profile: "leadresearch",
            division: "Research / Intelligence",
            charter: "Own research briefs.",
            cadence: "daily",
            skills: ["arxiv", "blogwatcher"],
            review: ["SEO Lead", "COO / Mission Control Lead"],
            bridgeUrl: "http://hermes-paperclip-org-bridge:8650/invoke",
          },
        },
      ],
      runs: [
        {
          id: "run-1",
          agentId: "agent-research",
          status: "completed",
          invocationSource: "on_demand",
          triggerDetail: "manual",
          startedAt: new Date("2026-06-01T10:01:00.000Z"),
          finishedAt: new Date("2026-06-01T10:02:00.000Z"),
          createdAt: new Date("2026-06-01T10:00:30.000Z"),
          error: null,
        },
      ],
    });

    expect(summary.totalAgents).toBe(2);
    expect(summary.activeAgents).toBe(2);
    expect(summary.bridgeAgents).toBe(2);
    expect(summary.divisions).toEqual([
      {
        name: "Executive / Coordination",
        agentCount: 1,
        activeCount: 1,
        runningRunCount: 0,
        agents: [expect.objectContaining({ profile: "leadcoo", review: ["Audit Lead"] })],
      },
      {
        name: "Research / Intelligence",
        agentCount: 1,
        activeCount: 1,
        runningRunCount: 0,
        agents: [expect.objectContaining({ profile: "leadresearch", recentRuns: [expect.objectContaining({ id: "run-1" })] })],
      },
    ]);
    expect(summary.firstActivationPod.map((agent) => agent.profile)).toEqual(["leadcoo", "leadresearch"]);
  });
});
