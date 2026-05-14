import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCapabilityService = vi.hoisted(() => ({
  getCompanyDefaults: vi.fn(),
  updateCompanyDefaults: vi.fn(),
  getAgentCapabilities: vi.fn(),
  updateAgentCapabilities: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/agent-capabilities.js", () => ({
  agentCapabilityService: () => mockCapabilityService,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

async function createApp(actor: Record<string, unknown> = {}) {
  const [{ agentCapabilityRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agent-capabilities.js")>("../routes/agent-capabilities.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
      ...actor,
    };
    next();
  });
  app.use("/api", agentCapabilityRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function capabilityResponse() {
  return {
    scope: "company_default",
    companyId: "company-1",
    agentId: null,
    config: {
      version: 1,
      mcpServers: [
        {
          id: "paperclip-local",
          provider: "manual",
          displayName: "Paperclip MCP",
          transport: "stdio",
          command: "npx -y @paperclipai/mcp-server",
          requiredSecretNames: ["PAPERCLIP_API_KEY"],
          desiredState: "enabled",
          liveState: "not_installed",
        },
      ],
      skillRefs: ["native-mcp"],
      toolRefs: ["paperclipApiRequest"],
      liveApply: false,
      liveExternalActions: false,
    },
    applyPreview: {
      dryRunAvailable: true,
      requiresApprovalForLiveApply: true,
      liveApply: false,
      liveExternalActions: false,
    },
  };
}

describe("agent capability routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const mock of Object.values(mockCapabilityService)) mock.mockReset();
    mockLogActivity.mockReset();
  });

  it("returns persisted company default desired MCP capability config", async () => {
    const app = await createApp();
    mockCapabilityService.getCompanyDefaults.mockResolvedValue(capabilityResponse());

    const res = await request(app).get("/api/companies/company-1/capabilities").expect(200);

    expect(res.body.config.mcpServers[0]).toMatchObject({
      id: "paperclip-local",
      liveState: "not_installed",
    });
    expect(res.body.applyPreview).toMatchObject({
      dryRunAvailable: true,
      requiresApprovalForLiveApply: true,
      liveExternalActions: false,
    });
    expect(mockCapabilityService.getCompanyDefaults).toHaveBeenCalledWith("company-1");
  });

  it("saves company defaults as desired config and logs only a safe summary", async () => {
    const app = await createApp();
    const response = capabilityResponse();
    mockCapabilityService.updateCompanyDefaults.mockResolvedValue(response);

    await request(app)
      .patch("/api/companies/company-1/capabilities")
      .send({
        config: {
          mcpServers: [
            {
              id: "paperclip-local",
              provider: "manual",
              displayName: "Paperclip MCP",
              transport: "stdio",
              command: "npx -y @paperclipai/mcp-server",
              requiredSecretNames: ["PAPERCLIP_API_KEY"],
            },
          ],
          skillRefs: ["native-mcp"],
          toolRefs: ["paperclipApiRequest"],
        },
      })
      .expect(200);

    expect(mockCapabilityService.updateCompanyDefaults).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        mcpServers: [expect.objectContaining({ id: "paperclip-local", liveState: "not_installed" })],
        liveApply: false,
        liveExternalActions: false,
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "company.agent_capabilities_updated",
        details: expect.not.objectContaining({ command: expect.anything() }),
      }),
    );
    const details = mockLogActivity.mock.calls[0]?.[1]?.details;
    expect(JSON.stringify(details)).not.toContain("npx -y");
  });

  it("saves agent-local desired MCP capability config without live install", async () => {
    const app = await createApp();
    mockCapabilityService.getAgentCapabilities.mockResolvedValue({
      ...capabilityResponse(),
      scope: "agent_local",
      agentId: "agent-1",
    });
    mockCapabilityService.updateAgentCapabilities.mockResolvedValue({
      ...capabilityResponse(),
      scope: "agent_local",
      agentId: "agent-1",
    });

    const res = await request(app)
      .patch("/api/agents/agent-1/capabilities")
      .send({
        config: {
          mcpServers: [
            {
              id: "manual",
              provider: "manual",
              displayName: "Manual MCP",
              command: "npx -y @acme/mcp-server",
            },
          ],
        },
      })
      .expect(200);

    expect(res.body).toMatchObject({
      scope: "agent_local",
      applyPreview: { requiresApprovalForLiveApply: true, liveApply: false },
    });
    expect(mockCapabilityService.updateAgentCapabilities).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        mcpServers: [expect.objectContaining({ id: "manual", liveState: "not_installed" })],
      }),
    );
  });

  it("rejects desired capability updates from agent-authenticated callers", async () => {
    const app = await createApp({ type: "agent", agentId: "agent-1", companyId: "company-1" });

    await request(app)
      .patch("/api/agents/agent-1/capabilities")
      .send({ config: { mcpServers: [] } })
      .expect(403);

    expect(mockCapabilityService.updateAgentCapabilities).not.toHaveBeenCalled();
  });
});
