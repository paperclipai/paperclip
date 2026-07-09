import { describe, expect, it, vi, beforeEach } from "vitest";
import { HttpError } from "../errors.js";
import { briefsService } from "../services/briefs.js";

const requireBuiltInAgentMock = vi.hoisted(() => vi.fn());

vi.mock("../services/built-in-agents.js", () => ({
  builtInAgentService: () => ({
    requireBuiltInAgent: requireBuiltInAgentMock,
  }),
}));

describe("briefs service", () => {
  beforeEach(() => {
    requireBuiltInAgentMock.mockReset();
  });

  it("requires the briefs built-in agent before returning the overview", async () => {
    requireBuiltInAgentMock.mockResolvedValue({
      definition: {
        key: "briefs",
        displayName: "Briefs Agent",
        featureKeys: ["briefs"],
      },
      agent: {
        id: "agent-1",
        name: "Briefs Agent",
        status: "idle",
        adapterType: "codex_local",
      },
      warning: null,
    });

    const overview = await briefsService({} as any).overview("company-1", {
      now: new Date("2026-07-07T22:45:00.000Z"),
    });

    expect(requireBuiltInAgentMock).toHaveBeenCalledWith("company-1", "briefs");
    expect(overview).toMatchObject({
      featureKey: "briefs",
      status: "ready",
      generatedAt: "2026-07-07T22:45:00.000Z",
      agent: {
        id: "agent-1",
        name: "Briefs Agent",
        status: "idle",
        adapterType: "codex_local",
      },
      warning: null,
    });
  });

  it("marks non-invokable built-in agents as unavailable", async () => {
    requireBuiltInAgentMock.mockResolvedValue({
      definition: {
        key: "briefs",
        displayName: "Briefs Agent",
        featureKeys: ["briefs"],
      },
      agent: {
        id: "agent-1",
        name: "Briefs Agent",
        status: "pending_approval",
        adapterType: "codex_local",
      },
      warning: {
        code: "built_in_agent_unavailable",
        key: "briefs",
        agentId: "agent-1",
        message: "Briefs Agent is pending approval.",
        status: "pending_approval",
        pauseReason: null,
      },
    });

    const overview = await briefsService({} as any).overview("company-1");

    expect(overview.status).toBe("unavailable");
    expect(overview.warning).toMatchObject({
      code: "built_in_agent_unavailable",
      status: "pending_approval",
    });
  });

  it("passes through the built-in missing-agent 412", async () => {
    const error = new HttpError(412, "Built-in agent is not configured: briefs", {
      code: "built_in_agent_not_configured",
      key: "briefs",
      status: "not_provisioned",
      agentId: null,
      featureKeys: ["briefs"],
    });
    requireBuiltInAgentMock.mockRejectedValue(error);

    await expect(briefsService({} as any).overview("company-1")).rejects.toBe(error);
  });
});
