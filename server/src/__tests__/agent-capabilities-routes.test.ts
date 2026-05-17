import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCapabilityService = vi.hoisted(() => ({
  getCompanyDefaults: vi.fn(),
  updateCompanyDefaults: vi.fn(),
  getAgentCapabilities: vi.fn(),
  updateAgentCapabilities: vi.fn(),
  previewApplyForCompany: vi.fn(),
  previewApplyForAgent: vi.fn(),
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

  // LET-336 Apply Preview dry-run endpoint coverage.
  describe("apply-preview (LET-140-F dry-run)", () => {
    function sanitizedProposal(overrides: Record<string, unknown> = {}) {
      return {
        dryRun: true,
        liveActionPerformed: false,
        liveApply: false,
        liveExternalActions: false,
        scope: "agent_local" as const,
        companyId: "company-1",
        agentId: "agent-1",
        status: "changes_pending_approval" as const,
        approvalRequiredForLiveApply: true,
        proposalIdentity: "acp1:deadbeefdeadbeef",
        generatedAt: "2026-05-17T00:00:00.000Z",
        copy: {
          headline: "Apply Preview — dry-run, changes pending approval",
          dryRunNote:
            "Dry-run only. No live MCP install, connect, execute, apply, or external action occurred from this preview.",
          safetyStatement:
            "Desired-vs-live: this preview describes desired config changes. Live apply, install, connect, execute, and external actions remain approval-gated and are not performed by this endpoint.",
          rollbackNote: "If an approved live apply later proceeds, rollback consists of saving the prior desired config.",
        },
        totals: { additions: 1, removals: 0, updates: 0 },
        riskSummary: { highRiskCount: 1, mediumRiskCount: 0, lowRiskCount: 0 },
        mcpServers: {
          additions: [
            {
              id: "paperclip-local",
              kind: "add",
              displayName: "Paperclip MCP",
              transport: "stdio",
              desiredState: "enabled",
              liveState: "not_installed",
              requiredSecretNames: ["PAPERCLIP_API_KEY"],
              missingSecretNames: ["PAPERCLIP_API_KEY"],
              hasCommand: true,
              hasRemoteUrl: false,
              riskClass: "high",
              approvalRequiredForLiveApply: true,
              changedFields: [],
            },
          ],
          removals: [],
          updates: [],
        },
        skillRefs: { additions: [], removals: [] },
        toolRefs: { additions: [], removals: [] },
        requiredSecretNames: ["PAPERCLIP_API_KEY"],
        missingSecretNames: ["PAPERCLIP_API_KEY"],
        expectedEffects: [
          'Would record desired MCP server "paperclip-local" (stdio). Live install/connect/execute remains approval-gated; no live action occurs from this preview.',
        ],
        inheritedContext: { note: "Per-category inheritance applies.", globalDefaultsAvailable: true },
        ...overrides,
      };
    }

    it("returns sanitized dry-run proposal for company defaults and never performs live action", async () => {
      const app = await createApp();
      mockCapabilityService.previewApplyForCompany.mockResolvedValue(
        sanitizedProposal({ scope: "company_default", agentId: null, inheritedContext: null }),
      );

      const res = await request(app)
        .post("/api/companies/company-1/capabilities/apply-preview")
        .send({
          draftConfig: {
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
          },
          availableSecretNames: [],
        })
        .expect(200);

      expect(res.body).toMatchObject({
        dryRun: true,
        liveActionPerformed: false,
        approvalRequiredForLiveApply: true,
        status: "changes_pending_approval",
      });
      expect(JSON.stringify(res.body)).not.toContain("npx -y");
      expect(JSON.stringify(res.body)).not.toContain("@paperclipai/mcp-server");
      expect(mockCapabilityService.previewApplyForCompany).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({ mcpServers: expect.any(Array) }),
        [],
      );
      expect(mockCapabilityService.updateCompanyDefaults).not.toHaveBeenCalled();
      expect(mockLogActivity).not.toHaveBeenCalled();
    });

    it("returns dry-run proposal for agent-local scope with desired-vs-live wording and missing-secret posture", async () => {
      const app = await createApp();
      mockCapabilityService.getAgentCapabilities.mockResolvedValue(capabilityResponse());
      mockCapabilityService.previewApplyForAgent.mockResolvedValue(sanitizedProposal());

      const res = await request(app)
        .post("/api/agents/agent-1/capabilities/apply-preview")
        .send({
          draftConfig: {
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
          },
          availableSecretNames: [],
        })
        .expect(200);

      expect(res.body.copy.dryRunNote).toMatch(/dry-run/i);
      expect(res.body.copy.safetyStatement).toMatch(/approval-gated/i);
      expect(res.body.copy.safetyStatement).toMatch(/desired/i);
      expect(res.body.copy.safetyStatement).toMatch(/live/i);
      expect(res.body.missingSecretNames).toContain("PAPERCLIP_API_KEY");
      expect(res.body.inheritedContext).toMatchObject({ globalDefaultsAvailable: true });
      expect(mockCapabilityService.previewApplyForAgent).toHaveBeenCalledWith(
        "agent-1",
        expect.objectContaining({ mcpServers: expect.any(Array) }),
        [],
      );
      expect(mockCapabilityService.updateAgentCapabilities).not.toHaveBeenCalled();
      expect(mockLogActivity).not.toHaveBeenCalled();
    });

    it("supports an empty body to return a deterministic no-op proposal from persisted desired config", async () => {
      const app = await createApp();
      mockCapabilityService.getAgentCapabilities.mockResolvedValue(capabilityResponse());
      mockCapabilityService.previewApplyForAgent.mockResolvedValue(
        sanitizedProposal({
          status: "no_op",
          approvalRequiredForLiveApply: false,
          totals: { additions: 0, removals: 0, updates: 0 },
          mcpServers: { additions: [], removals: [], updates: [] },
          requiredSecretNames: [],
          missingSecretNames: [],
          expectedEffects: ["Desired config is already aligned with the draft."],
        }),
      );

      const res = await request(app)
        .post("/api/agents/agent-1/capabilities/apply-preview")
        .send({})
        .expect(200);

      expect(res.body.status).toBe("no_op");
      expect(res.body.approvalRequiredForLiveApply).toBe(false);
      expect(mockCapabilityService.previewApplyForAgent).toHaveBeenCalledWith(
        "agent-1",
        undefined,
        undefined,
      );
    });

    it("rejects raw secret values in draftConfig at the validation layer", async () => {
      const app = await createApp();

      await request(app)
        .post("/api/companies/company-1/capabilities/apply-preview")
        .send({
          draftConfig: {
            mcpServers: [
              {
                id: "leak",
                provider: "manual",
                displayName: "Leak",
                transport: "stdio",
                command: "leak --api-key sk_live_should_not_be_here",
              },
            ],
          },
        })
        .expect(400);

      expect(mockCapabilityService.previewApplyForCompany).not.toHaveBeenCalled();
    });
  });
});
