import { describe, expect, it, vi } from "vitest";
import { createDecisionWakeOriginAgent } from "../services/decision-wakeup.js";

const input = {
  companyId: "company-1",
  agentId: "agent-1",
  issueId: "issue-1",
  decisionId: "decision-1",
  outcome: "decided" as const,
};

describe("createDecisionWakeOriginAgent", () => {
  it("does not enqueue when the heartbeat runtime is disabled", async () => {
    await expect(createDecisionWakeOriginAgent(null)(input)).resolves.toBeNull();
  });

  it("maps a decision continuation onto the enabled heartbeat runtime", async () => {
    const wakeup = vi.fn().mockResolvedValue({ id: "run-1" });

    await expect(createDecisionWakeOriginAgent(wakeup)(input)).resolves.toEqual({ id: "run-1" });
    expect(wakeup).toHaveBeenCalledWith("agent-1", {
      source: "automation",
      triggerDetail: "system",
      reason: "decision_decided",
      payload: { issueId: "issue-1", decisionId: "decision-1", outcome: "decided" },
    });
  });
});
