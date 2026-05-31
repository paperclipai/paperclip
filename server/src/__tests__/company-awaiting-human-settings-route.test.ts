import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCompanyService = vi.hoisted(() => ({
  list: vi.fn(),
  stats: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  ensureMembership: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockCompanyPortabilityService = vi.hoisted(() => ({
  exportBundle: vi.fn(),
  previewExport: vi.fn(),
  previewImport: vi.fn(),
  importBundle: vi.fn(),
}));

const mockAwaitingHumanSettingsService = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
  resolveProvider: vi.fn(),
  resolveClickUpRuntimeConfig: vi.fn(),
  getStored: vi.fn(),
}));

const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(),
  listFeedbackTraces: vi.fn(),
  getFeedbackTraceById: vi.fn(),
  saveIssueVote: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockSendClickUpTransportTestMessage = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  accessService: () => mockAccessService,
  budgetService: () => mockBudgetService,
  companyPortabilityService: () => mockCompanyPortabilityService,
  companyService: () => mockCompanyService,
  awaitingHumanSettingsService: () => mockAwaitingHumanSettingsService,
  feedbackService: () => mockFeedbackService,
  logActivity: mockLogActivity,
}));

vi.mock("../services/clickup-awaiting-human-transport.js", () => ({
  sendClickUpTransportTestMessage: mockSendClickUpTransportTestMessage,
}));

async function createApp() {
  const [{ companyRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/companies.js")>("../routes/companies.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    };
    next();
  });
  app.use("/api/companies", companyRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("PATCH /api/companies/:companyId/awaiting-human-settings", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/companies.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.resetAllMocks();
  });

  it("rejects invalid payloads before company lookup runs", async () => {
    const app = await createApp();

    const res = await request(app)
      .patch("/api/companies/company-1/awaiting-human-settings")
      .send({
        enabled: true,
        provider: "clickup",
        providerConfig: {
          workspaceId: 123,
          channelId: "channel-1",
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
    expect(mockCompanyService.getById).not.toHaveBeenCalled();
    expect(mockAwaitingHumanSettingsService.update).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("sends connection-test message to ClickUp channel", async () => {
    mockCompanyService.getById.mockResolvedValueOnce({
      id: "company-1",
      name: "Bizbox",
    });
    mockAwaitingHumanSettingsService.resolveClickUpRuntimeConfig.mockRejectedValueOnce(new Error("awaiting-human-bridge-disabled"));
    mockSendClickUpTransportTestMessage.mockResolvedValueOnce({
      status: "sent",
      channel: "clickup-chat",
      detail: "sent",
      externalId: "message-1",
    });

    const app = await createApp();

    const res = await request(app)
      .post("/api/companies/company-1/awaiting-human-settings/connection-test")
      .send({
        provider: "clickup",
        providerConfig: {
          workspaceId: "workspace-1",
          channelId: "channel-1",
        },
        clickupPersonalToken: "token-123",
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "sent",
      channel: "clickup-chat",
      detail: "ClickUp bridge connection test succeeded. Message delivered to configured channel (message message-1).",
      externalId: "message-1",
    });
    expect(mockSendClickUpTransportTestMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Bizbox ClickUp bridge connection test",
        summary: "Bizbox completed a bridge transport test for ClickUp.",
        body: "The configured bridge successfully delivered a test payload to the target ClickUp channel.",
        cta: "No action is required.",
      }),
      {
        personalToken: "token-123",
        workspaceId: "workspace-1",
        channelId: "channel-1",
      },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "company.awaiting_human_settings.connection_tested",
    }));
  });
});
