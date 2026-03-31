import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { providerAuthRoutes } from "../routes/provider-auth.js";

const mockProviderAuth = vi.hoisted(() => ({
  getProviderStatus: vi.fn(),
  getAnthropicAuthState: vi.fn(),
  startAnthropicAuth: vi.fn(),
  submitAnthropicAuthCode: vi.fn(),
  cancelAnthropicAuth: vi.fn(),
  getOpenAiAuthState: vi.fn(),
  startOpenAiAuth: vi.fn(),
  cancelOpenAiAuth: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  listCompanyIds: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/provider-auth.js", () => mockProviderAuth);

vi.mock("../services/index.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
  logActivity: mockLogActivity,
}));

function createApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", providerAuthRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("provider auth routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1"]);
    mockProviderAuth.startAnthropicAuth.mockResolvedValue({
      status: "waiting",
      authDetected: false,
      verificationUrl: "https://claude.example.test",
    });
    mockProviderAuth.cancelOpenAiAuth.mockResolvedValue({
      status: "canceled",
      authDetected: false,
      verificationUrl: "https://auth.openai.com/codex/device",
    });
  });

  it("logs activity for Anthropic auth start", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: true,
      companyIds: ["company-1"],
    });

    const res = await request(app).post("/api/provider-auth/anthropic/start");

    expect(res.status).toBe(200);
    expect(mockProviderAuth.startAnthropicAuth).toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      {} as any,
      expect.objectContaining({
        companyId: "company-1",
        action: "instance.provider_auth.anthropic_started",
      }),
    );
  });

  it("logs activity for OpenAI auth cancel", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: true,
      companyIds: ["company-1"],
    });

    const res = await request(app).post("/api/provider-auth/openai/cancel");

    expect(res.status).toBe(200);
    expect(mockProviderAuth.cancelOpenAiAuth).toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      {} as any,
      expect.objectContaining({
        companyId: "company-1",
        action: "instance.provider_auth.openai_canceled",
      }),
    );
  });

  it("rejects non-admin callers", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app).post("/api/provider-auth/anthropic/start");

    expect(res.status).toBe(403);
    expect(mockProviderAuth.startAnthropicAuth).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});
