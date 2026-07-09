import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  companySecretBindings,
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
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecrets);
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
      transport: "remote_http",
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
});
