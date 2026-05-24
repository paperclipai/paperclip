import { describe, expect, it } from "vitest";
import { buildAgentContextUsageEstimate } from "../services/heartbeat.ts";

const baseAgent = {
  id: "11111111-1111-4111-8111-111111111111",
  companyId: "22222222-2222-4222-8222-222222222222",
  name: "Context Agent",
  adapterType: "codex_local",
  adapterConfig: {},
  runtimeConfig: {
    heartbeat: {
      contextMonitor: {
        contextWindowTokens: 1_000,
        warningRatio: 0.8,
        preemptRatio: 0.9,
      },
    },
  },
  capabilities: "x".repeat(400),
};

describe("agent context usage estimates", () => {
  it("classifies warning and preempt bands from estimated token pressure", () => {
    const warning = buildAgentContextUsageEstimate({
      agent: baseAgent,
      recentRunUsageTokens: 650,
      assignedTicketTextTokens: 50,
      now: new Date("2026-05-24T12:00:00Z"),
    });

    expect(warning.components.capabilitiesTokens).toBe(100);
    expect(warning.estimatedTokens).toBe(800);
    expect(warning.band).toBe("warn");

    const preempt = buildAgentContextUsageEstimate({
      agent: baseAgent,
      recentRunUsageTokens: 750,
      assignedTicketTextTokens: 50,
      now: new Date("2026-05-25T02:30:00Z"),
    });

    expect(preempt.estimatedTokens).toBe(900);
    expect(preempt.band).toBe("preempt");
    expect(preempt.quietWindow).toBe(true);
  });

  it("keeps normal estimates below the warning threshold", () => {
    const estimate = buildAgentContextUsageEstimate({
      agent: baseAgent,
      recentRunUsageTokens: 300,
      assignedTicketTextTokens: 50,
      now: new Date("2026-05-24T12:00:00Z"),
    });

    expect(estimate.estimatedTokens).toBe(450);
    expect(estimate.band).toBe("ok");
    expect(estimate.quietWindow).toBe(false);
  });
});
