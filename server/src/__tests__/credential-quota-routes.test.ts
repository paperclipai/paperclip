import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetchClaudeQuota = vi.hoisted(() => vi.fn());
const mockFetchClaudeCliQuotaForOAuth = vi.hoisted(() => vi.fn());
const mockFetchCodexQuota = vi.hoisted(() => vi.fn());
const mockRunCodexLogin = vi.hoisted(() => vi.fn());
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(async () => true),
}));
const mockCredentialService = vi.hoisted(() => ({
  list: vi.fn(),
  getDecryptedPayload: vi.fn(),
}));

vi.mock("@paperclipai/adapter-claude-local/server", () => ({
  fetchClaudeQuota: mockFetchClaudeQuota,
  fetchClaudeCliQuotaForOAuth: mockFetchClaudeCliQuotaForOAuth,
}));

vi.mock("@paperclipai/adapter-codex-local/server", () => ({
  fetchCodexQuota: mockFetchCodexQuota,
  runCodexLogin: mockRunCodexLogin,
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  credentialService: () => mockCredentialService,
  logActivity: mockLogActivity,
}));

import { errorHandler } from "../middleware/index.js";
import { credentialRoutes } from "../routes/credentials.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { actor: Record<string, unknown> }).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: true,
    };
    next();
  });
  app.use("/api", credentialRoutes({} as never));
  app.use(errorHandler);
  return app;
}

function claudeCredential(id: string) {
  return {
    id,
    companyId: "company-1",
    name: id,
    type: "claude_oauth",
    isDefault: true,
    cooldownUntil: null,
    cooldownReason: null,
    lastUsedAt: null,
    consecutiveFailureCount: 0,
    disabledAt: null,
    disabledReason: null,
    createdAt: new Date("2026-06-20T00:00:00Z"),
    updatedAt: new Date("2026-06-20T00:00:00Z"),
  };
}

describe("credential quota route caching", () => {
  beforeEach(() => {
    mockFetchClaudeQuota.mockReset();
    mockFetchClaudeCliQuotaForOAuth.mockReset();
    mockFetchCodexQuota.mockReset();
    mockRunCodexLogin.mockReset();
    mockLogActivity.mockReset();
    mockAccessService.canUser.mockClear();
    mockCredentialService.list.mockReset();
    mockCredentialService.getDecryptedPayload.mockReset();
    mockCredentialService.getDecryptedPayload.mockResolvedValue({ accessToken: "claude-token" });
  });

  it("reuses a recent successful Claude OAuth quota sample instead of polling Anthropic every dashboard refresh", async () => {
    const app = createApp();
    mockCredentialService.list.mockResolvedValue([claudeCredential("claude-cache-success")]);
    mockFetchClaudeQuota.mockResolvedValue([
      {
        label: "Current session",
        usedPercent: 42,
        resetsAt: "2026-06-20T05:00:00Z",
        valueLabel: null,
        detail: null,
      },
    ]);

    const first = await request(app).get("/api/companies/company-1/credentials/quota-windows").expect(200);
    const second = await request(app).get("/api/companies/company-1/credentials/quota-windows").expect(200);

    expect(mockFetchClaudeQuota).toHaveBeenCalledTimes(1);
    expect(first.body[0]).toMatchObject({
      ok: true,
      source: "anthropic-oauth-usage",
      quotaWindows: [{ label: "Current session", usedPercent: 42 }],
    });
    expect(second.body[0]).toMatchObject({
      ok: true,
      source: "anthropic-oauth-usage",
      quotaWindows: [{ label: "Current session", usedPercent: 42 }],
    });
  });

  it("caches a recent Claude 429 so the dashboard does not keep hammering the usage endpoint", async () => {
    const app = createApp();
    mockCredentialService.list.mockResolvedValue([claudeCredential("claude-cache-429")]);
    mockFetchClaudeQuota.mockRejectedValue(new Error("anthropic usage api returned 429"));
    mockFetchClaudeCliQuotaForOAuth.mockRejectedValue(new Error("Could not parse Claude CLI usage output."));

    const first = await request(app).get("/api/companies/company-1/credentials/quota-windows").expect(200);
    const second = await request(app).get("/api/companies/company-1/credentials/quota-windows").expect(200);

    expect(mockFetchClaudeQuota).toHaveBeenCalledTimes(1);
    expect(mockFetchClaudeCliQuotaForOAuth).toHaveBeenCalledTimes(1);
    expect(first.body[0]).toMatchObject({
      ok: false,
      quotaWindows: [],
      error: "Anthropic usage endpoint is rate limited (HTTP 429). OAuth can still be active; showing the last successful quota sample when available.",
    });
    expect(second.body[0]).toMatchObject({
      ok: false,
      quotaWindows: [],
      error: "Anthropic usage endpoint is rate limited (HTTP 429). OAuth can still be active; showing the last successful quota sample when available.",
    });
  });

  it("falls back to parsing Claude CLI /usage when the OAuth usage endpoint is rate limited", async () => {
    const app = createApp();
    mockCredentialService.list.mockResolvedValue([claudeCredential("claude-cli-fallback")]);
    mockCredentialService.getDecryptedPayload.mockResolvedValue({
      accessToken: "claude-token",
      refreshToken: "refresh-token",
      subscriptionType: "max",
    });
    mockFetchClaudeQuota.mockRejectedValue(new Error("anthropic usage api returned 429"));
    mockFetchClaudeCliQuotaForOAuth.mockResolvedValue([
      {
        label: "Current session",
        usedPercent: 12,
        resetsAt: null,
        valueLabel: null,
        detail: "Resets 5pm",
      },
      {
        label: "Current week (all models)",
        usedPercent: 34,
        resetsAt: null,
        valueLabel: null,
        detail: "Resets Monday",
      },
    ]);

    const response = await request(app).get("/api/companies/company-1/credentials/quota-windows").expect(200);

    expect(mockFetchClaudeQuota).toHaveBeenCalledTimes(1);
    expect(mockFetchClaudeCliQuotaForOAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "claude-token",
        refreshToken: "refresh-token",
        subscriptionType: "max",
      }),
      { timeoutMs: 45_000 },
    );
    expect(response.body[0]).toMatchObject({
      ok: true,
      source: "claude-cli-usage",
      quotaWindows: [
        { label: "Current session", usedPercent: 12 },
        { label: "Current week (all models)", usedPercent: 34 },
      ],
    });
  });
});
