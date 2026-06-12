import { beforeEach, describe, expect, it, vi } from "vitest";
import { companyAwaitingHumanSettingsRoutes } from "../routes/company-awaiting-human-settings.js";

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

vi.mock("../routes/builder.js", () => ({
  companyBuilderRoutes: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../services/clickup-awaiting-human-transport.js", () => ({
  sendClickUpTransportTestMessage: mockSendClickUpTransportTestMessage,
}));

type MockResponse = {
  statusCode: number;
  body: unknown;
  status(code: number): MockResponse;
  json(payload: unknown): MockResponse;
};

function createMockResponse(): MockResponse {
  return {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
}

async function runConnectionTestRoute(body: unknown) {
  const router = companyAwaitingHumanSettingsRoutes({} as any);
  const routeLayer = router.stack.find(
    (layer: any) => layer.route?.path === "/connection-test" && layer.route?.methods?.post,
  );
  if (!routeLayer?.route?.stack?.length) {
    throw new Error("connection-test route not found");
  }
  const [validateMiddleware, connectionTestHandler] = routeLayer.route.stack.map((layer: any) => layer.handle);
  const req: any = {
    body,
    params: { companyId: "company-1" },
    actor: {
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    },
  };
  const res = createMockResponse();

  try {
    validateMiddleware(req, res, () => undefined);
    await connectionTestHandler(req, res, () => undefined);
    return res;
  } catch (error) {
    const { errorHandler } = await vi.importActual<typeof import("../middleware/index.js")>(
      "../middleware/index.js",
    );
    const errorRes = createMockResponse();
    errorHandler(error as Error, req, errorRes as any, () => undefined);
    return errorRes;
  }
}

describe("PATCH /api/companies/:companyId/awaiting-human-settings", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.resetAllMocks();
  });

  it("rejects invalid payloads before company lookup runs", async () => {
    const res = await runConnectionTestRoute({
      enabled: true,
      provider: "clickup",
      providerConfig: {
        workspaceId: 123,
        channelId: "channel-1",
        primaryReviewerUserId: null,
        secondaryReviewerUserId: null,
      },
    });

    expect(res.statusCode).toBe(400);
    expect((res.body as { error?: string } | undefined)?.error).toBe("Validation error");
    expect(mockCompanyService.getById).not.toHaveBeenCalled();
    expect(mockAwaitingHumanSettingsService.update).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("sends connection-test message to ClickUp channel", async () => {
    mockCompanyService.getById.mockResolvedValueOnce({
      id: "company-1",
      issuePrefix: "CITAAAA",
      name: "Bizbox",
    });
    mockSendClickUpTransportTestMessage.mockResolvedValueOnce({
      status: "sent",
      channel: "clickup-chat",
      detail: "sent",
      externalId: "message-1",
    });

    const res = await runConnectionTestRoute({
      provider: "clickup",
      providerConfig: {
        workspaceId: "workspace-1",
        channelId: "channel-1",
        primaryReviewerUserId: null,
        secondaryReviewerUserId: null,
      },
      clickupPersonalToken: "token-123",
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: "sent",
      channel: "clickup-chat",
      detail: "ClickUp bridge connection test succeeded. Message delivered to configured channel (message message-1).",
      externalId: "message-1",
    });
    const [transportPayload, transportOverrides] = mockSendClickUpTransportTestMessage.mock.calls[0] ?? [];
    expect(transportPayload).toMatchObject({
      title: "Bizbox ClickUp bridge connection test",
      summary: "Bizbox completed a bridge transport test for ClickUp.",
      body: "The configured bridge successfully delivered a test payload to the target ClickUp channel.",
      link: "http://localhost:3100/CITAAAA/company/settings/awaiting-human",
      cta: "No action is required.",
      reviewerTargets: [],
    });
    expect(transportOverrides).toEqual({
      personalToken: "token-123",
      workspaceId: "workspace-1",
      channelId: "channel-1",
      primaryReviewerUserId: null,
      secondaryReviewerUserId: null,
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "company.awaiting_human_settings.connection_tested",
    }));
  });

  it("sends reviewer notification test message when requested", async () => {
    mockCompanyService.getById.mockResolvedValueOnce({
      id: "company-1",
      name: "Bizbox",
    });
    mockSendClickUpTransportTestMessage.mockResolvedValueOnce({
      status: "sent",
      channel: "clickup-chat",
      detail: "sent",
      externalId: "message-2",
    });

    const res = await runConnectionTestRoute({
      provider: "clickup",
      connectionTestMode: "reviewers",
      providerConfig: {
        workspaceId: "workspace-1",
        channelId: "channel-1",
        primaryReviewerUserId: "primary-user-id",
        secondaryReviewerUserId: "secondary-user-id",
      },
      clickupPersonalToken: "token-123",
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: "sent",
      channel: "clickup-chat",
      detail: "ClickUp reviewer notification test succeeded. Message delivered to configured channel (message message-2).",
      externalId: "message-2",
    });
    expect(mockSendClickUpTransportTestMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Bizbox ClickUp reviewer notification test",
        summary: "Bizbox completed a reviewer notification test for ClickUp.",
        body: "The configured bridge successfully delivered a reviewer notification test payload to the target ClickUp channel.",
        cta: "No action is required.",
        reviewerTargets: [
          { label: "Primary reviewer", userId: "primary-user-id" },
          { label: "Secondary reviewer", userId: "secondary-user-id" },
        ],
      }),
      {
        personalToken: "token-123",
        workspaceId: "workspace-1",
        channelId: "channel-1",
        primaryReviewerUserId: "primary-user-id",
        secondaryReviewerUserId: "secondary-user-id",
      },
    );
  });
});
