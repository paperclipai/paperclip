import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { secretRoutes } from "../routes/secrets.js";
import { errorHandler } from "../middleware/error-handler.js";
import { HttpError, unprocessable } from "../errors.js";

const mockSecretService = vi.hoisted(() => ({
  listProviders: vi.fn(),
  checkProviders: vi.fn(),
  listProviderConfigs: vi.fn(),
  getProviderConfigById: vi.fn(),
  createProviderConfig: vi.fn(),
  updateProviderConfig: vi.fn(),
  disableProviderConfig: vi.fn(),
  setDefaultProviderConfig: vi.fn(),
  checkProviderConfigHealth: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  previewRemoteImport: vi.fn(),
  importRemoteSecrets: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  secretService: () => mockSecretService,
  logActivity: mockLogActivity,
}));

function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "user-1",
  source: "session",
  companyIds: ["company-1"],
  memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", secretRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("secret routes", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockSecretService)) {
      mock.mockReset();
    }
    mockLogActivity.mockReset();
  });

  it("returns provider health checks for board callers with company access", async () => {
    mockSecretService.checkProviders.mockResolvedValue([
      {
        provider: "local_encrypted",
        status: "ok",
        message: "Local encrypted provider configured",
        backupGuidance: ["Back up the key file together with database backups."],
      },
    ]);

    const res = await request(createApp()).get("/api/companies/company-1/secret-providers/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      providers: [
        {
          provider: "local_encrypted",
          status: "ok",
          message: "Local encrypted provider configured",
          backupGuidance: ["Back up the key file together with database backups."],
        },
      ],
    });
  });

  it("rejects managed secret creation when externalRef is supplied", async () => {
    const res = await request(createApp()).post("/api/companies/company-1/secrets").send({
      name: "OpenAI API Key",
      managedMode: "paperclip_managed",
      value: "secret-value",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/other",
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/Managed secrets cannot set externalRef/);
    expect(mockSecretService.create).not.toHaveBeenCalled();
  });

  it("rejects provider vault routes for non-board actors", async () => {
    const res = await request(createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
    })).get("/api/companies/company-1/secret-provider-configs");

    expect(res.status).toBe(403);
    expect(mockSecretService.listProviderConfigs).not.toHaveBeenCalled();
  });

  it("rejects provider vault cross-company access before calling the service", async () => {
    const res = await request(createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      companyIds: ["company-2"],
      memberships: [{ companyId: "company-2", status: "active", membershipRole: "admin" }],
    })).get("/api/companies/company-1/secret-provider-configs");

    expect(res.status).toBe(403);
    expect(mockSecretService.listProviderConfigs).not.toHaveBeenCalled();
  });

  it("rejects sensitive provider vault config fields", async () => {
    const res = await request(createApp()).post("/api/companies/company-1/secret-provider-configs").send({
      provider: "aws_secrets_manager",
      displayName: "AWS prod",
      config: {
        region: "us-east-1",
        accessKeyId: "AKIA...",
      },
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/sensitive field/i);
    expect(mockSecretService.createProviderConfig).not.toHaveBeenCalled();
  });

  it("rejects ready status for coming-soon provider vaults", async () => {
    const res = await request(createApp()).post("/api/companies/company-1/secret-provider-configs").send({
      provider: "vault",
      displayName: "Vault draft",
      status: "ready",
      config: {
        address: "https://vault.example.com",
      },
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/locked while coming soon/i);
    expect(mockSecretService.createProviderConfig).not.toHaveBeenCalled();
  });

  it("rejects credential-bearing Vault provider vault addresses before persistence", async () => {
    const res = await request(createApp()).post("/api/companies/company-1/secret-provider-configs").send({
      provider: "vault",
      displayName: "Vault draft",
      config: {
        address: "https://user:pass@vault.example.com",
      },
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/origin-only HTTP\(S\) URL/i);
    expect(mockSecretService.createProviderConfig).not.toHaveBeenCalled();
  });

  it.each([
    "https://vault.example.com?token=hvs.x",
    "https://vault.example.com#token=hvs.x",
  ])("rejects token-bearing Vault provider vault address %s before persistence", async (address) => {
    const res = await request(createApp()).post("/api/companies/company-1/secret-provider-configs").send({
      provider: "vault",
      displayName: "Vault draft",
      config: { address },
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/origin-only HTTP\(S\) URL/i);
    expect(mockSecretService.createProviderConfig).not.toHaveBeenCalled();
  });

  it("rejects unsafe Vault provider vault address patches before persistence", async () => {
    const res = await request(createApp()).patch("/api/secret-provider-configs/vault-1").send({
      config: {
        address: "https://vault.example.com#token=hvs.x",
      },
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/origin-only HTTP\(S\) URL/i);
    expect(mockSecretService.getProviderConfigById).not.toHaveBeenCalled();
    expect(mockSecretService.updateProviderConfig).not.toHaveBeenCalled();
  });

  it("creates provider vaults and logs safe activity details", async () => {
    const createdAt = new Date("2026-05-06T00:00:00.000Z");
    mockSecretService.createProviderConfig.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      provider: "aws_secrets_manager",
      displayName: "AWS prod",
      status: "ready",
      isDefault: true,
      config: { region: "us-east-1" },
      healthStatus: null,
      healthCheckedAt: null,
      healthMessage: null,
      healthDetails: null,
      disabledAt: null,
      createdByAgentId: null,
      createdByUserId: "user-1",
      createdAt,
      updatedAt: createdAt,
    });

    const res = await request(createApp()).post("/api/companies/company-1/secret-provider-configs").send({
      provider: "aws_secrets_manager",
      displayName: "AWS prod",
      isDefault: true,
      config: { region: "us-east-1" },
    });

    expect(res.status).toBe(201);
    expect(mockSecretService.createProviderConfig).toHaveBeenCalledWith(
      "company-1",
      {
        provider: "aws_secrets_manager",
        displayName: "AWS prod",
        status: undefined,
        isDefault: true,
        config: { region: "us-east-1" },
      },
      { userId: "user-1", agentId: null },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "secret_provider_config.created",
      details: {
        provider: "aws_secrets_manager",
        displayName: "AWS prod",
        status: "ready",
        isDefault: true,
      },
    }));
    expect(JSON.stringify(mockLogActivity.mock.calls)).not.toContain("accessKey");
  });

  it("rejects remote import preview for non-board actors", async () => {
    const res = await request(createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
    })).post("/api/companies/company-1/secrets/remote-import/preview").send({
      providerConfigId: "11111111-1111-4111-8111-111111111111",
    });

    expect(res.status).toBe(403);
    expect(mockSecretService.previewRemoteImport).not.toHaveBeenCalled();
  });

  it("previews remote imports and logs only aggregate metadata", async () => {
    mockSecretService.previewRemoteImport.mockResolvedValue({
      providerConfigId: "11111111-1111-4111-8111-111111111111",
      provider: "aws_secrets_manager",
      nextToken: null,
      candidates: [
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/openai",
          remoteName: "prod/openai",
          name: "openai",
          key: "openai",
          providerVersionRef: null,
          providerMetadata: { description: "OpenAI API key" },
          status: "ready",
          importable: true,
          conflicts: [],
        },
      ],
    });

    const res = await request(createApp())
      .post("/api/companies/company-1/secrets/remote-import/preview")
      .send({
        providerConfigId: "11111111-1111-4111-8111-111111111111",
        query: "openai",
        pageSize: 25,
      });

    expect(res.status).toBe(200);
    expect(mockSecretService.previewRemoteImport).toHaveBeenCalledWith("company-1", {
      providerConfigId: "11111111-1111-4111-8111-111111111111",
      query: "openai",
      nextToken: undefined,
      pageSize: 25,
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "secret.remote_import.previewed",
      details: {
        provider: "aws_secrets_manager",
        candidateCount: 1,
        readyCount: 1,
        duplicateCount: 0,
        conflictCount: 0,
      },
    }));
    expect(JSON.stringify(mockLogActivity.mock.calls)).not.toContain("prod/openai");
  });

  it("returns sanitized remote import preview provider errors", async () => {
    mockSecretService.previewRemoteImport.mockRejectedValue(
      new HttpError(
        403,
        "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
        { code: "access_denied" },
      ),
    );

    const res = await request(createApp())
      .post("/api/companies/company-1/secrets/remote-import/preview")
      .send({
        providerConfigId: "11111111-1111-4111-8111-111111111111",
      });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
      details: { code: "access_denied" },
    });
    expect(JSON.stringify(res.body)).not.toContain("arn:aws");
    expect(JSON.stringify(res.body)).not.toContain("123456789012");
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("imports remote references and logs aggregate row counts", async () => {
    mockSecretService.importRemoteSecrets.mockResolvedValue({
      providerConfigId: "11111111-1111-4111-8111-111111111111",
      provider: "aws_secrets_manager",
      importedCount: 1,
      skippedCount: 0,
      errorCount: 0,
      results: [
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/openai",
          name: "OpenAI API key",
          key: "openai-api-key",
          status: "imported",
          reason: null,
          secretId: "22222222-2222-4222-8222-222222222222",
          conflicts: [],
        },
      ],
    });

    const res = await request(createApp())
      .post("/api/companies/company-1/secrets/remote-import")
      .send({
        providerConfigId: "11111111-1111-4111-8111-111111111111",
        secrets: [
          {
            externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/openai",
            name: "OpenAI API key",
            key: "openai-api-key",
            description: "Operator-entered Paperclip description",
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(mockSecretService.importRemoteSecrets).toHaveBeenCalledWith(
      "company-1",
      {
        providerConfigId: "11111111-1111-4111-8111-111111111111",
        secrets: [
          {
            externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/openai",
            name: "OpenAI API key",
            key: "openai-api-key",
            description: "Operator-entered Paperclip description",
          },
        ],
      },
      { userId: "user-1", agentId: null },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "secret.remote_import.completed",
      details: {
        provider: "aws_secrets_manager",
        importedCount: 1,
        skippedCount: 0,
        errorCount: 0,
      },
    }));
    expect(JSON.stringify(mockLogActivity.mock.calls)).not.toContain("prod/openai");
  });

  it("surfaces update-route externalRef retarget rejection without logging raw refs", async () => {
    mockSecretService.getById.mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      companyId: "company-1",
      name: "OpenAI API key",
      key: "openai-api-key",
      provider: "aws_secrets_manager",
      managedMode: "external_reference",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/original",
    });
    mockSecretService.update.mockRejectedValue(
      unprocessable("External reference secrets cannot be retargeted through generic update"),
    );

    const res = await request(createApp())
      .patch("/api/secrets/22222222-2222-4222-8222-222222222222")
      .send({
        externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/repointed",
      });

    expect(res.status).toBe(422);
    expect(mockSecretService.update).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/repointed",
      }),
    );
    expect(mockLogActivity).not.toHaveBeenCalled();
    expect(JSON.stringify(mockLogActivity.mock.calls)).not.toContain("shared/repointed");
  });

  it("allows DELETE to retry cleanup for already soft-deleted secrets", async () => {
    const secret = {
      id: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      name: "OpenAI API Key__deleted__33333333-3333-4333-8333-333333333333",
      key: "openai-api-key__deleted__33333333-3333-4333-8333-333333333333",
      provider: "aws_secrets_manager",
      managedMode: "paperclip_managed",
      status: "deleted",
    };
    mockSecretService.getById.mockResolvedValue(secret);
    mockSecretService.remove.mockResolvedValue(secret);

    const res = await request(createApp()).delete(
      "/api/secrets/33333333-3333-4333-8333-333333333333",
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockSecretService.remove).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333",
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "secret.deleted",
        companyId: "company-1",
        entityId: secret.id,
      }),
    );
  });
});
