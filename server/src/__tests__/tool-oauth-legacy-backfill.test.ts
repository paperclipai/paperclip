import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecrets,
  companySecretVersions,
  createDb,
  secretAccessEvents,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { backfillLegacyToolOAuthTokens } from "../services/tool-oauth-legacy-backfill.js";
import { secretService } from "../services/secrets.js";
import { awsSecretsManagerProvider } from "../secrets/aws-secrets-manager-provider.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createCompany(db: ReturnType<typeof createDb>) {
  return db
    .insert(companies)
    .values({
      name: `OAuth Legacy ${randomUUID()}`,
      issuePrefix: `OL${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

describeEmbeddedPostgres("tool OAuth legacy backfill", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tool-oauth-backfill-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("moves legacy raw OAuth tokens into secret refs and removes JSONB token keys idempotently", async () => {
    const company = await createCompany(db);
    const [application] = await db.insert(toolApplications).values({
      companyId: company.id,
      applicationKey: `legacy-oauth-${randomUUID()}`,
      name: `Legacy OAuth ${randomUUID()}`,
      type: "mcp_http",
      status: "active",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: company.id,
      applicationId: application!.id,
      name: `Legacy OAuth Connection ${randomUUID()}`,
      uid: `test/${randomUUID()}`,
      transport: "mcp_remote",
      status: "active",
      enabled: true,
      config: {
        url: "https://legacy.example.test/mcp",
        oauth: {
          provider: "legacy",
          tokenUrl: "https://legacy.example.test/oauth/token",
          access_token: "legacy-access-token",
          refresh_token: "legacy-refresh-token",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      },
      transportConfig: {
        url: "https://legacy.example.test/mcp",
        oauth: {
          access_token: "legacy-access-token",
          refresh_token: "legacy-refresh-token",
        },
      },
      credentialSecretRefs: [],
      credentialRefs: [],
    }).returning();

    const first = await backfillLegacyToolOAuthTokens(db);

    expect(first).toMatchObject({
      scannedConnections: 1,
      migratedConnections: 1,
      sanitizedConnections: 1,
      createdSecrets: 2,
      rotatedSecrets: 0,
      accessTokensBackfilled: 1,
      refreshTokensBackfilled: 1,
    });
    const [updated] = await db.select().from(toolConnections).where(eq(toolConnections.id, connection!.id));
    expect(JSON.stringify(updated!.config)).not.toContain("legacy-access-token");
    expect(JSON.stringify(updated!.config)).not.toContain("legacy-refresh-token");
    expect(JSON.stringify(updated!.config)).not.toContain("access_token");
    expect(JSON.stringify(updated!.config)).not.toContain("refresh_token");
    expect(JSON.stringify(updated!.transportConfig)).not.toContain("access_token");
    expect(updated!.credentialSecretRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ configPath: "oauth.access_token", label: "OAuth access token" }),
      expect.objectContaining({ configPath: "oauth.refresh_token", label: "OAuth refresh token" }),
    ]));
    expect(updated!.credentialRefs).toEqual([
      expect.objectContaining({ name: "oauth.access_token", key: "Authorization", prefix: "Bearer " }),
    ]);
    const secretRows = await db.select().from(companySecrets).where(eq(companySecrets.companyId, company.id));
    expect(secretRows.map((secret) => secret.key).sort()).toEqual([
      `tool-connection/${connection!.id}/oauth/access-token`,
      `tool-connection/${connection!.id}/oauth/refresh-token`,
    ].sort());
    await expect(db.select().from(companySecretVersions)).resolves.toHaveLength(2);

    const secrets = secretService(db);
    const accessRef = updated!.credentialSecretRefs.find((ref) => ref.configPath === "oauth.access_token")!;
    const refreshRef = updated!.credentialSecretRefs.find((ref) => ref.configPath === "oauth.refresh_token")!;
    await expect(secrets.resolveSecretValue(company.id, accessRef.secretId, "latest", {
      consumerType: "tool_connection",
      consumerId: connection!.id,
      configPath: "oauth.access_token",
      actorType: "system",
    })).resolves.toBe("legacy-access-token");
    await expect(secrets.resolveSecretValue(company.id, refreshRef.secretId, "latest", {
      consumerType: "tool_connection",
      consumerId: connection!.id,
      configPath: "oauth.refresh_token",
      actorType: "system",
    })).resolves.toBe("legacy-refresh-token");
    const accessEvents = await db.select().from(secretAccessEvents);
    expect(accessEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        consumerType: "tool_connection",
        consumerId: connection!.id,
        configPath: "oauth.access_token",
        outcome: "success",
      }),
      expect.objectContaining({
        consumerType: "tool_connection",
        consumerId: connection!.id,
        configPath: "oauth.refresh_token",
        outcome: "success",
      }),
    ]));

    const second = await backfillLegacyToolOAuthTokens(db);
    expect(second).toMatchObject({
      scannedConnections: 0,
      migratedConnections: 0,
      sanitizedConnections: 0,
      createdSecrets: 0,
      rotatedSecrets: 0,
    });
    await expect(db.select().from(companySecretVersions)).resolves.toHaveLength(2);
  });

  it("preserves an existing deterministic OAuth secret provider when rotating legacy material", async () => {
    const company = await createCompany(db);
    const [application] = await db.insert(toolApplications).values({
      companyId: company.id,
      applicationKey: `legacy-oauth-aws-${randomUUID()}`,
      name: `Legacy OAuth AWS ${randomUUID()}`,
      type: "mcp_http",
      status: "active",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: company.id,
      applicationId: application!.id,
      name: `Legacy OAuth AWS Connection ${randomUUID()}`,
      uid: `test/${randomUUID()}`,
      transport: "mcp_remote",
      status: "active",
      enabled: true,
      config: {
        url: "https://legacy-aws.example.test/mcp",
        oauth: {
          provider: "legacy",
          access_token: "legacy-access-token",
        },
      },
      transportConfig: {},
      credentialSecretRefs: [],
      credentialRefs: [],
    }).returning();

    const externalRef =
      `arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/oauth/${connection!.id}`;
    const createVersionSpy = vi.spyOn(awsSecretsManagerProvider, "createVersion").mockResolvedValue({
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId: externalRef,
        versionId: "aws-version-2",
        source: "managed",
      },
      valueSha256: "value-sha-2",
      fingerprintSha256: "fingerprint-sha-2",
      externalRef,
      providerVersionRef: "aws-version-2",
    });
    const secrets = secretService(db);
    const awsVault = await secrets.createProviderConfig(company.id, {
      provider: "aws_secrets_manager",
      displayName: "AWS OAuth vault",
      config: { region: "us-east-1", namespace: "oauth-test", secretNamePrefix: "paperclip" },
    });
    const resolveSpy = vi.spyOn(awsSecretsManagerProvider, "resolveVersion").mockImplementation(async (input) => {
      expect(input.material).toMatchObject({
        scheme: "aws_secrets_manager_v1",
        versionId: "aws-version-2",
      });
      expect(input.providerVersionRef).toBe("aws-version-2");
      expect(input.providerConfig).toEqual(expect.objectContaining({
        id: awsVault.id,
        provider: "aws_secrets_manager",
      }));
      return "legacy-access-token";
    });
    const deterministicKey = `tool-connection/${connection!.id}/oauth/access-token`;
    const [existingSecret] = await db.insert(companySecrets).values({
      companyId: company.id,
      key: deterministicKey,
      name: `Existing OAuth access ${randomUUID()}`,
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
      status: "active",
      managedMode: "paperclip_managed",
      externalRef,
      latestVersion: 1,
      createdByUserId: "test",
      lastRotatedAt: new Date(),
    }).returning();
    await db.insert(companySecretVersions).values({
      secretId: existingSecret!.id,
      version: 1,
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId: externalRef,
        versionId: "aws-version-1",
        source: "managed",
      },
      valueSha256: "value-sha-1",
      fingerprintSha256: "fingerprint-sha-1",
      providerVersionRef: "aws-version-1",
      status: "current",
      createdByUserId: "test",
    });

    const result = await backfillLegacyToolOAuthTokens(db);

    expect(result).toMatchObject({
      scannedConnections: 1,
      migratedConnections: 1,
      sanitizedConnections: 1,
      createdSecrets: 0,
      rotatedSecrets: 1,
      accessTokensBackfilled: 1,
      refreshTokensBackfilled: 0,
    });
    expect(createVersionSpy).toHaveBeenCalledWith(expect.objectContaining({
      providerConfig: expect.objectContaining({ id: awsVault.id, provider: "aws_secrets_manager" }),
      context: expect.objectContaining({
        companyId: company.id,
        secretKey: deterministicKey,
        version: 2,
      }),
    }));

    const [updatedConnection] = await db
      .select()
      .from(toolConnections)
      .where(eq(toolConnections.id, connection!.id));
    expect(JSON.stringify(updatedConnection!.config)).not.toContain("legacy-access-token");
    expect(JSON.stringify(updatedConnection!.config)).not.toContain("access_token");
    const accessRef = updatedConnection!.credentialSecretRefs.find((ref) => ref.configPath === "oauth.access_token")!;
    expect(accessRef.secretId).toBe(existingSecret.id);

    const [updatedSecret] = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.id, existingSecret.id));
    expect(updatedSecret).toMatchObject({
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
      latestVersion: 2,
      externalRef,
    });
    const versions = await db
      .select()
      .from(companySecretVersions)
      .where(eq(companySecretVersions.secretId, existingSecret.id));
    expect(versions).toEqual(expect.arrayContaining([
      expect.objectContaining({ version: 1, status: "previous" }),
      expect.objectContaining({
        version: 2,
        status: "current",
        material: expect.objectContaining({
          scheme: "aws_secrets_manager_v1",
          versionId: "aws-version-2",
        }),
        providerVersionRef: "aws-version-2",
      }),
    ]));

    await expect(secrets.resolveSecretValue(company.id, accessRef.secretId, "latest", {
      consumerType: "tool_connection",
      consumerId: connection!.id,
      configPath: "oauth.access_token",
      actorType: "system",
    })).resolves.toBe("legacy-access-token");
    expect(resolveSpy).toHaveBeenCalled();
  });
});
