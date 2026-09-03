import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("returns a live overview for the ready Briefs agent", async () => {
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

    const overview = await briefsService({} as never).overview("company-1", {
      now: new Date("2026-07-07T22:45:00.000Z"),
    });

    expect(requireBuiltInAgentMock).toHaveBeenCalledWith("company-1", "briefs");
    expect(overview).toEqual({
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
      summaryItems: [
        { label: "Agent", value: "Briefs Agent", detail: "idle" },
        { label: "Adapter", value: "codex_local" },
        { label: "Last checked", value: "2026-07-07T22:45:00.000Z" },
      ],
    });
  });

  it("keeps paused Briefs content available with a warning", async () => {
    requireBuiltInAgentMock.mockResolvedValue({
      definition: {
        key: "briefs",
        displayName: "Briefs Agent",
        featureKeys: ["briefs"],
      },
      agent: {
        id: "agent-1",
        name: "Briefs Agent",
        status: "paused",
        adapterType: "codex_local",
      },
      warning: {
        code: "built_in_agent_paused",
        key: "briefs",
        agentId: "agent-1",
        message: "Built-in agent briefs is paused; scheduled/background work should be skipped.",
        pauseReason: "maintenance",
      },
    });

    const overview = await briefsService({} as never).overview("company-1");

    expect(overview.status).toBe("paused");
    expect(overview.warning).toMatchObject({
      code: "built_in_agent_paused",
      pauseReason: "maintenance",
    });
  });

  it("passes through the missing, setup, or pending built-in 412", async () => {
    const error = new HttpError(412, "Built-in agent is not configured: briefs", {
      code: "built_in_agent_not_configured",
      key: "briefs",
      status: "needs_setup",
      agentId: "agent-1",
      featureKeys: ["briefs"],
    });
    requireBuiltInAgentMock.mockRejectedValue(error);

    await expect(briefsService({} as never).overview("company-1")).rejects.toBe(error);
  });
});
