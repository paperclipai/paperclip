import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { providerConnectionRoutes } from "../routes/provider-connections.js";
import { errorHandler } from "../middleware/index.js";

const mockProviderCredentialService = vi.hoisted(() => ({
  normalizeProviderId: vi.fn((value: string) => value.trim().toLowerCase()),
  normalizeEnvKey: vi.fn((value: string) => value.trim().toUpperCase()),
  listByProvider: vi.fn(),
  getByProviderLabel: vi.fn(),
  create: vi.fn(),
  ensureForSecret: vi.fn(),
  rotate: vi.fn(),
  update: vi.fn(),
  getById: vi.fn(),
  remove: vi.fn(),
  setDefault: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  getByName: vi.fn(),
}));

const mockAdapterAuthService = vi.hoisted(() => ({
  getStatus: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  providerCredentialService: () => mockProviderCredentialService,
  secretService: () => mockSecretService,
  adapterAuthService: () => mockAdapterAuthService,
  logActivity: mockLogActivity,
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: true,
    };
    next();
  });
  app.use("/api", providerConnectionRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("provider connection routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProviderCredentialService.listByProvider.mockResolvedValue([]);
    mockProviderCredentialService.getByProviderLabel.mockResolvedValue(null);
    mockSecretService.getByName.mockResolvedValue(null);
    mockLogActivity.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns grouped provider credentials and legacy connection fields", async () => {
    mockProviderCredentialService.listByProvider.mockResolvedValue([
      {
        provider: "openai",
        defaultCredentialId: "cred-openai",
        credentials: [
          {
            id: "cred-openai",
            companyId: "company-1",
            provider: "openai",
            envKey: "OPENAI_API_KEY",
            label: "Default",
            secretId: "secret-openai",
            isDefault: true,
            createdAt: new Date("2026-04-01T00:00:00.000Z"),
            updatedAt: new Date("2026-04-01T00:00:00.000Z"),
            secretName: "OPENAI_API_KEY",
            secretLatestVersion: 2,
            secretUpdatedAt: new Date("2026-04-01T00:00:00.000Z"),
          },
        ],
      },
    ]);

    const res = await request(createApp()).get("/api/companies/company-1/provider-connections");

    expect(res.status).toBe(200);
    expect(res.body.providers).toHaveLength(1);
    expect(res.body.openai.connected).toBe(true);
    expect(res.body.openai.secretId).toBe("secret-openai");
    expect(res.body.anthropic.connected).toBe(false);
  });

  it("returns adapter auth status for creation UIs", async () => {
    mockAdapterAuthService.getStatus.mockResolvedValue({
      adapterType: "codex_local",
      requirements: [],
      unresolvedCount: 0,
      status: "resolved",
    });

    const res = await request(createApp())
      .post("/api/companies/company-1/provider-connections/adapter-auth-status")
      .send({
        adapterType: "codex_local",
        adapterConfig: {},
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("resolved");
    expect(mockAdapterAuthService.getStatus).toHaveBeenCalledWith(
      "company-1",
      "codex_local",
      {},
    );
  });

  it("validates and creates provider credentials", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);

    mockProviderCredentialService.create.mockResolvedValue({
      id: "cred-openai",
      companyId: "company-1",
      provider: "openai",
      envKey: "OPENAI_API_KEY",
      label: "Primary",
      secretId: "secret-openai",
      isDefault: true,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      secretName: "OPENAI_API_KEY__OPENAI__PRIMARY",
      secretLatestVersion: 1,
      secretUpdatedAt: new Date("2026-04-01T00:00:00.000Z"),
    });

    const res = await request(createApp())
      .post("/api/companies/company-1/provider-connections/credentials")
      .send({
        provider: "openai",
        envKey: "OPENAI_API_KEY",
        label: "Primary",
        apiKey: "sk-test-valid-key",
        isDefault: true,
      });

    expect(res.status).toBe(201);
    expect(res.body.label).toBe("Primary");
    expect(mockProviderCredentialService.create).toHaveBeenCalled();
  });
});
