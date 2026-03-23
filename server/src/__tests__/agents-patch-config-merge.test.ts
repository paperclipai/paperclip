import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  hasPermission: vi.fn(),
  canUser: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({}));
const mockHeartbeatService = vi.hoisted(() => ({}));
const mockIssueApprovalService = vi.hoisted(() => ({}));
const mockIssueService = vi.hoisted(() => ({}));
const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockBudgetService = vi.hoisted(() => ({}));
const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockAgentInstructionsService = vi.hoisted(() => ({
  getBundle: vi.fn(),
  syncFromFilePath: vi.fn(),
}));
const mockCompanySkillService = vi.hoisted(() => ({
  listForCompany: vi.fn().mockResolvedValue([]),
  listForAgent: vi.fn().mockResolvedValue([]),
}));
const mockTokenAnalyticsService = vi.hoisted(() => ({
  getAgentStats: vi.fn().mockResolvedValue({}),
}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn().mockResolvedValue({ experimentalSettings: {} }),
}));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  budgetService: () => mockBudgetService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => mockIssueService,
  secretService: () => mockSecretService,
  workspaceOperationService: () => mockWorkspaceOperationService,
  agentInstructionsService: () => mockAgentInstructionsService,
  companySkillService: () => mockCompanySkillService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent: unknown, config: unknown) => config),
  logActivity: mockLogActivity,
}));

vi.mock("../services/token-analytics.js", () => ({
  tokenAnalyticsService: () => mockTokenAnalyticsService,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const existingAgent = {
  id: "11111111-1111-4111-8111-111111111111",
  companyId: "company-1",
  name: "Agent One",
  role: "general",
  status: "active",
  adapterType: "process",
  adapterConfig: {
    preserved: "keep-me",
    overridden: "old-value",
    clearMe: "remove-me",
  },
  runtimeConfig: {
    retained: "runtime-keep",
    changed: "runtime-old",
    clearRuntime: "runtime-remove",
  },
};

describe("PATCH /api/agents/:id config merge behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockResolvedValue(existingAgent);
    mockSecretService.normalizeAdapterConfigForPersistence.mockImplementation(
      async (_companyId: string, config: Record<string, unknown>) => config,
    );
    mockAgentService.update.mockImplementation(
      async (_id: string, patchData: Record<string, unknown>) => ({ ...existingAgent, ...patchData }),
    );
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("partially patches adapterConfig/runtimeConfig by shallow-merging existing fields", async () => {
    const res = await request(createApp())
      .patch("/api/agents/11111111-1111-4111-8111-111111111111")
      .send({
        adapterConfig: { overridden: "new-value" },
        runtimeConfig: { changed: "runtime-new" },
      });

    expect(res.status).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        adapterConfig: {
          preserved: "keep-me",
          overridden: "new-value",
          clearMe: "remove-me",
        },
        runtimeConfig: {
          retained: "runtime-keep",
          changed: "runtime-new",
          clearRuntime: "runtime-remove",
        },
      }),
      expect.anything(),
    );
  });

  it("applies full config objects when all fields are provided", async () => {
    const res = await request(createApp())
      .patch("/api/agents/11111111-1111-4111-8111-111111111111")
      .send({
        adapterConfig: {
          preserved: "adapter-updated",
          overridden: "adapter-overridden",
          clearMe: "adapter-reset",
        },
        runtimeConfig: {
          retained: "runtime-updated",
          changed: "runtime-overridden",
          clearRuntime: "runtime-reset",
        },
      });

    expect(res.status).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        adapterConfig: {
          preserved: "adapter-updated",
          overridden: "adapter-overridden",
          clearMe: "adapter-reset",
        },
        runtimeConfig: {
          retained: "runtime-updated",
          changed: "runtime-overridden",
          clearRuntime: "runtime-reset",
        },
      }),
      expect.anything(),
    );
  });

  it("supports null values to clear individual config fields while preserving siblings", async () => {
    const res = await request(createApp())
      .patch("/api/agents/11111111-1111-4111-8111-111111111111")
      .send({
        adapterConfig: { clearMe: null },
        runtimeConfig: { clearRuntime: null },
      });

    expect(res.status).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        adapterConfig: {
          preserved: "keep-me",
          overridden: "old-value",
          clearMe: null,
        },
        runtimeConfig: {
          retained: "runtime-keep",
          changed: "runtime-old",
          clearRuntime: null,
        },
      }),
      expect.anything(),
    );
  });

  it("rejects non-object runtimeConfig before reaching update", async () => {
    const res = await request(createApp())
      .patch("/api/agents/11111111-1111-4111-8111-111111111111")
      .send({ runtimeConfig: "not-an-object" });

    // Schema validation may reject with 400, or our guard returns 422.
    // Either way, update must not be called with invalid data.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });
});
