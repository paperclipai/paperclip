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
  previewProviderConfigDiscovery: vi.fn(),
  getProviderConfigById: vi.fn(),
  createProviderConfig: vi.fn(),
  updateProviderConfig: vi.fn(),
  disableProviderConfig: vi.fn(),
  removeProviderConfig: vi.fn(),
  setDefaultProviderConfig: vi.fn(),
  checkProviderConfigHealth: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  rotate: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  listUserSecretDefinitions: vi.fn(),
  createUserSecretDefinition: vi.fn(),
  updateUserSecretDefinition: vi.fn(),
  removeUserSecretDefinition: vi.fn(),
  getUserSecretDefinitionCoverage: vi.fn(),
  listCurrentUserSecretValues: vi.fn(),
  createCurrentUserSecretValue: vi.fn(),
  updateCurrentUserSecretValue: vi.fn(),
  rotateCurrentUserSecretValue: vi.fn(),
  removeCurrentUserSecretValue: vi.fn(),
  previewRemoteImport: vi.fn(),
  importRemoteSecrets: vi.fn(),
  listBindingReferences: vi.fn(),
  listAccessEvents: vi.fn(),
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

  it("returns sanitized AWS provider errors when managed secret creation fails", async () => {
    mockSecretService.create.mockRejectedValue(
      new HttpError(
        403,
        "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
        {
          code: "access_denied",
          provider: "aws_secrets_manager",
          operation: "secret.create",
          providerConfigId: "11111111-1111-4111-8111-111111111111",
          region: "us-east-1",
          credentialPath: "Paperclip server runtime/provider credential path",
          requiredCapability: "secretsmanager:CreateSecret",
          actionableMessage:
            "AWS managed secret creation needs secretsmanager:CreateSecret in the selected region for this provider vault.",
          safeAlternative:
            "If the secret already exists in AWS, link it as an external reference instead of creating a Paperclip-managed value.",
        },
      ),
    );

    const res = await request(createApp()).post("/api/companies/company-1/secrets").send({
      name: "Vercel token",
      key: "vercel_token",
      provider: "aws_secrets_manager",
      providerConfigId: "11111111-1111-4111-8111-111111111111",
      managedMode: "paperclip_managed",
      value: "vcp_test",
    });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: "access_denied",
      error: "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
      details: {
        code: "access_denied",
        provider: "aws_secrets_manager",
        operation: "secret.create",
        providerConfigId: "11111111-1111-4111-8111-111111111111",
        region: "us-east-1",
        requiredCapability: "secretsmanager:CreateSecret",
      },
    });
    expect(JSON.stringify(res.body)).not.toContain("arn:aws");
    expect(JSON.stringify(res.body)).not.toContain("123456789012");
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("restricts user secret definition management to company admins", async () => {
    const res = await request(createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "member" }],
    })).post("/api/companies/company-1/user-secret-definitions").send({
      key: "github_token",
      name: "GitHub token",
      provider: "local_encrypted",
    });

    expect(res.status).toBe(403);
    expect(mockSecretService.createUserSecretDefinition).not.toHaveBeenCalled();
  });

  it("records implicit user-secret definition admins as system actors instead of board pseudo-users", async () => {
    mockSecretService.createUserSecretDefinition.mockResolvedValue({
      id: "definition-1",
      companyId: "company-1",
      key: "github_token",
      name: "GitHub token",
      provider: "local_encrypted",
      status: "active",
    });

    const res = await request(createApp({
      type: "board",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: ["company-1"],
      memberships: [],
    })).post("/api/companies/company-1/user-secret-definitions").send({
      key: "github_token",
      name: "GitHub token",
      provider: "local_encrypted",
    });

    expect(res.status).toBe(201);
    expect(mockSecretService.createUserSecretDefinition).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ key: "github_token" }),
      { userId: null, agentId: null },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorType: "system",
        actorId: "local_implicit",
        action: "user_secret_definition.created",
      }),
    );
    expect(JSON.stringify(mockLogActivity.mock.calls)).not.toContain("\"board\"");
  });

  it("logs patched user-secret definition deletion as deletion activity", async () => {
    mockSecretService.updateUserSecretDefinition.mockResolvedValue({
      id: "definition-1",
      companyId: "company-1",
      key: "github_token__deleted__definition-1",
      name: "GitHub token",
      provider: "local_encrypted",
      status: "deleted",
    });

    const res = await request(createApp())
      .patch("/api/companies/company-1/user-secret-definitions/definition-1")
      .send({ status: "deleted" });

    expect(res.status).toBe(200);
    expect(mockSecretService.updateUserSecretDefinition).toHaveBeenCalledWith(
      "company-1",
      "definition-1",
      expect.objectContaining({ status: "deleted" }),
      { userId: "user-1", agentId: null },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "user_secret_definition.deleted",
        entityType: "user_secret_definition",
        entityId: "definition-1",
      }),
    );
  });

  it("creates current-user secret values for the authenticated user only", async () => {
    mockSecretService.createCurrentUserSecretValue.mockResolvedValue({
      id: "secret-1",
      companyId: "company-1",
      scope: "user",
      ownerUserId: "user-1",
      userSecretDefinitionId: "definition-1",
      provider: "local_encrypted",
      latestVersion: 1,
    });

    const res = await request(createApp()).post("/api/companies/company-1/me/user-secrets").send({
      definitionKey: "github_token",
      value: "secret-value",
    });

    expect(res.status).toBe(201);
    expect(mockSecretService.createCurrentUserSecretValue).toHaveBeenCalledWith(
      "company-1",
      "user-1",
      {
        definitionKey: "github_token",
        definitionId: undefined,
        value: "secret-value",
        externalRef: undefined,
        providerVersionRef: undefined,
        providerConfigId: undefined,
      },
      { userId: "user-1", agentId: null },
    );
    expect(JSON.stringify(mockLogActivity.mock.calls)).not.toContain("secret-value");
  });

  it("rejects current-user secret values without a concrete user identity", async () => {
    const res = await request(createApp({
      type: "board",
      source: "local_implicit",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
    })).post("/api/companies/company-1/me/user-secrets").send({
      definitionKey: "github_token",
      value: "secret-value",
    });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: "User identity required for user-specific secrets" });
    expect(mockSecretService.createCurrentUserSecretValue).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rejects empty current-user secret rotation payloads", async () => {
    const res = await request(createApp())
      .post("/api/companies/company-1/me/user-secrets/secret-1/rotate")
      .send({});

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/requires value, externalRef/);
    expect(mockSecretService.rotateCurrentUserSecretValue).not.toHaveBeenCalled();
  });

  it("hides user-scoped secrets from legacy company secret mutation routes", async () => {
    mockSecretService.getById.mockResolvedValue({
      id: "secret-1",
      companyId: "company-1",
      scope: "user",
      ownerUserId: "user-2",
      status: "active",
    });

    const res = await request(createApp()).post("/api/secrets/secret-1/rotate").send({
      value: "new-secret-value",
    });

    expect(res.status).toBe(404);
    expect(mockSecretService.rotate).not.toHaveBeenCalled();
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

  it("rejects provider vault discovery preview for non-board actors", async () => {
    const res = await request(createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
    }))
      .post("/api/companies/company-1/secret-provider-configs/discovery/preview")
      .send({
        provider: "aws_secrets_manager",
        config: { region: "us-east-1" },
      });

    expect(res.status).toBe(403);
    expect(mockSecretService.previewProviderConfigDiscovery).not.toHaveBeenCalled();
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

  it("rejects sensitive provider vault discovery draft config fields", async () => {
    const res = await request(createApp())
      .post("/api/companies/company-1/secret-provider-configs/discovery/preview")
      .send({
        provider: "aws_secrets_manager",
        config: {
          region: "us-east-1",
          secretAccessKey: "secret",
        },
      });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/sensitive field/i);
    expect(mockSecretService.previewProviderConfigDiscovery).not.toHaveBeenCalled();
  });

  it("previews provider vault discovery and logs only aggregate metadata", async () => {
    mockSecretService.previewProviderConfigDiscovery.mockResolvedValue({
      provider: "aws_secrets_manager",
      nextToken: null,
      sampledSecretCount: 2,
      skippedForeignPaperclipSampleCount: 0,
      candidates: [
        {
          provider: "aws_secrets_manager",
          displayName: "AWS production",
          config: {
            region: "us-east-1",
            namespace: "prod-use1",
            secretNamePrefix: "paperclip",
            environmentTag: "production",
            ownerTag: "platform",
            kmsKeyId: null,
          },
          sampleCount: 2,
          samples: [
            { name: "paperclip/prod-use1/company-1/openai", hasKmsKey: false, tagKeys: ["environment"] },
          ],
          signals: {
            namespace: "prod-use1",
            secretNamePrefix: "paperclip",
            environmentTag: "production",
            ownerTag: "platform",
            kmsKeyId: null,
            hasKmsKey: false,
            sampleCount: 2,
            paperclipManagedSampleCount: 0,
            skippedForeignPaperclipSampleCount: 0,
          },
          warnings: [],
        },
      ],
      warnings: [],
    });

    const res = await request(createApp())
      .post("/api/companies/company-1/secret-provider-configs/discovery/preview")
      .send({
        provider: "aws_secrets_manager",
        config: { region: "us-east-1" },
        query: "paperclip",
        pageSize: 25,
      });

    expect(res.status).toBe(200);
    expect(mockSecretService.previewProviderConfigDiscovery).toHaveBeenCalledWith("company-1", {
      provider: "aws_secrets_manager",
      config: { region: "us-east-1" },
      query: "paperclip",
      nextToken: undefined,
      pageSize: 25,
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "secret_provider_config.discovery_previewed",
      entityType: "secret_provider_config_discovery",
      entityId: "company-1",
      details: {
        provider: "aws_secrets_manager",
        candidateCount: 1,
        sampledSecretCount: 2,
        warningCount: 0,
      },
    }));
    expect(JSON.stringify(mockLogActivity.mock.calls)).not.toContain("paperclip/prod-use1/company-1/openai");
  });

  it("returns actionable sanitized provider vault discovery errors", async () => {
    mockSecretService.previewProviderConfigDiscovery.mockRejectedValue(
      new HttpError(
        403,
        "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
        {
          code: "access_denied",
          provider: "aws_secrets_manager",
          operation: "secret_provider_config.discovery.preview",
          providerConfigId: "discovery-preview",
          providerVaultContext: "draft_config",
          region: "us-east-1",
          credentialPath: "Paperclip server runtime/provider credential path",
          requiredCapability: "secretsmanager:ListSecrets",
          actionableMessage:
            "AWS discovery preview needs secretsmanager:ListSecrets in the selected region for the Paperclip server runtime/provider credential path.",
          safeAlternative:
            "If the operator already knows the exact AWS Secrets Manager ARN, paste/link that ARN instead of using discovery. Exact-resource DescribeSecret and runtime read permissions are still required.",
        },
      ),
    );

    const res = await request(createApp())
      .post("/api/companies/company-1/secret-provider-configs/discovery/preview")
      .send({
        provider: "aws_secrets_manager",
        config: { region: "us-east-1" },
        pageSize: 25,
      });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
      details: {
        code: "access_denied",
        provider: "aws_secrets_manager",
        operation: "secret_provider_config.discovery.preview",
        providerVaultContext: "draft_config",
        region: "us-east-1",
        requiredCapability: "secretsmanager:ListSecrets",
      },
    });
    expect(res.body.details.actionableMessage).toContain("Paperclip server runtime/provider credential path");
    expect(res.body.details.safeAlternative).toContain("paste/link that ARN");
    expect(JSON.stringify(res.body)).not.toContain("arn:aws");
    expect(JSON.stringify(res.body)).not.toContain("123456789012");
    expect(mockLogActivity).not.toHaveBeenCalled();
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

  it("removes provider vault config locally without deleting remote provider data", async () => {
    const createdAt = new Date("2026-05-06T00:00:00.000Z");
    const providerConfig = {
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      provider: "aws_secrets_manager",
      displayName: "AWS prod",
      status: "ready",
      isDefault: false,
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
    };
    mockSecretService.getProviderConfigById.mockResolvedValue(providerConfig);
    mockSecretService.removeProviderConfig.mockResolvedValue(providerConfig);

    const res = await request(createApp()).delete(
      "/api/secret-provider-configs/11111111-1111-4111-8111-111111111111",
    );

    expect(res.status).toBe(200);
    expect(mockSecretService.removeProviderConfig).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(mockSecretService.disableProviderConfig).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "secret_provider_config.removed",
      details: {
        provider: "aws_secrets_manager",
        displayName: "AWS prod",
        remoteDeleted: false,
      },
    }));
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
      code: "access_denied",
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

  it("returns 404 for cross-tenant GET /secrets/:id/usage without leaking existence", async () => {
    mockSecretService.getById.mockResolvedValue({
      id: "44444444-4444-4444-8444-444444444444",
      companyId: "company-2",
      name: "Other tenant secret",
      key: "other-secret",
      provider: "aws_secrets_manager",
      managedMode: "paperclip_managed",
    });

    const crossTenantApp = createApp({
      type: "board",
      userId: "mallory",
      source: "session",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
      isInstanceAdmin: false,
    });

    const res = await request(crossTenantApp).get(
      "/api/secrets/44444444-4444-4444-8444-444444444444/usage",
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Secret not found" });
    expect(mockSecretService.listBindingReferences).not.toHaveBeenCalled();
  });

  it("returns 404 for missing GET /secrets/:id/usage with identical response shape", async () => {
    mockSecretService.getById.mockResolvedValue(null);

    const res = await request(createApp()).get(
      "/api/secrets/55555555-5555-4555-8555-555555555555/usage",
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Secret not found" });
    expect(mockSecretService.listBindingReferences).not.toHaveBeenCalled();
  });

  it("returns 404 for cross-tenant GET /secrets/:id/access-events without leaking existence", async () => {
    mockSecretService.getById.mockResolvedValue({
      id: "66666666-6666-4666-8666-666666666666",
      companyId: "company-2",
      name: "Other tenant secret",
      key: "other-secret",
      provider: "aws_secrets_manager",
      managedMode: "paperclip_managed",
    });

    const crossTenantApp = createApp({
      type: "board",
      userId: "mallory",
      source: "session",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
      isInstanceAdmin: false,
    });

    const res = await request(crossTenantApp).get(
      "/api/secrets/66666666-6666-4666-8666-666666666666/access-events",
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Secret not found" });
    expect(mockSecretService.listAccessEvents).not.toHaveBeenCalled();
  });

  it("returns 404 for missing GET /secrets/:id/access-events with identical response shape", async () => {
    mockSecretService.getById.mockResolvedValue(null);

    const res = await request(createApp()).get(
      "/api/secrets/77777777-7777-4777-8777-777777777777/access-events",
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Secret not found" });
    expect(mockSecretService.listAccessEvents).not.toHaveBeenCalled();
  });

  it("returns usage bindings for in-tenant GET /secrets/:id/usage", async () => {
    mockSecretService.getById.mockResolvedValue({
      id: "88888888-8888-4888-8888-888888888888",
      companyId: "company-1",
      name: "OpenAI",
      key: "openai",
      provider: "aws_secrets_manager",
      managedMode: "paperclip_managed",
    });
    mockSecretService.listBindingReferences.mockResolvedValue([]);

    const res = await request(createApp()).get(
      "/api/secrets/88888888-8888-4888-8888-888888888888/usage",
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      secretId: "88888888-8888-4888-8888-888888888888",
      bindings: [],
    });
    expect(mockSecretService.listBindingReferences).toHaveBeenCalledWith(
      "company-1",
      "88888888-8888-4888-8888-888888888888",
    );
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
