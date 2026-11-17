import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  authUsers,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecrets,
  companySecretVersions,
  connectionGrants,
  connectionTokenIssuances,
  createDb,
  secretAccessEvents,
  toolAccessAuditEvents,
  toolApplications,
  toolCatalogEntries,
  toolConnectionContentDeletions,
  toolConnectionInstalls,
  toolConnections,
  toolOauthStates,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
  userSecretDeclarations,
  userSecretDefinitions,
} from "@paperclipai/db";
import { and, eq, isNull } from "drizzle-orm";
import { GOOGLE_WORKSPACE_CONNECTOR_PROFILES } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { toolAccessService } from "../services/tool-access.js";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { errorHandler } from "../middleware/index.js";
import { logger } from "../middleware/logger.js";
import { PaperclipCloudConnectorError, type PaperclipCloudConnector } from "../services/paperclip-cloud-connector.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const REFRESH_TOKEN = "gmail-refresh-token-do-not-log";

function fakeConnector(companyId: string, userId: string) {
  const credentials = {
    v: 1 as const,
    accessToken: "gmail-access-token",
    refreshToken: REFRESH_TOKEN,
    tokenType: "Bearer",
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshTokenExpiresAt: null,
    scopes: [...GOOGLE_WORKSPACE_CONNECTOR_PROFILES["gmail.draft"].scopes],
    subject: userId,
    companyId,
    instanceId: "test-instance",
    environment: "development" as const,
    provider: "google" as const,
    profile: "gmail.draft" as const,
  };
  return {
    getCapabilities: vi.fn(async () => ["gmail.draft" as const]),
    startAuthorization: vi.fn(async ({ returnState }: { returnState: string }) => ({
      authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?state=${encodeURIComponent(returnState)}`,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    })),
    claim: vi.fn(async () => credentials),
    refresh: vi.fn(async () => credentials),
    revoke: vi.fn(async (): Promise<{ outcome?: string }> => ({ outcome: "revoked" })),
  };
}

function toolsListFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    return Response.json({ jsonrpc: "2.0", id: body.id,
      result: body.method === "initialize" ? { protocolVersion: "2025-06-18" } : { tools: [] } });
  });
}

describeEmbeddedPostgres("removing a Paperclip-managed Google connection", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-google-removal-");
    db = createDb(tempDb.connectionString, { maxConnections: 4 });
    await instanceSettingsService(db).updateExperimental({ enableGoogleWorkspaceConnector: true });
  }, 20_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(toolConnectionContentDeletions);
    await db.delete(toolOauthStates);
    await db.delete(connectionTokenIssuances);
    await db.delete(connectionGrants);
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(userSecretDeclarations);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(userSecretDefinitions);
    await db.delete(activityLog);
    await db.delete(toolAccessAuditEvents);
    await db.delete(toolConnectionInstalls);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfileEntries);
    await db.delete(toolProfiles);
    await db.delete(toolCatalogEntries);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  async function connectManagedGmail() {
    const [company] = await db.insert(companies).values({
      name: `Google removal ${randomUUID()}`,
      issuePrefix: `GR${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning();
    const userId = `google-removal-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId: company!.id, principalType: "user", principalId: userId, status: "active", membershipRole: "owner",
    });
    const connector = fakeConnector(company!.id, userId);
    const cloudConnector = connector as unknown as PaperclipCloudConnector;
    const service = toolAccessService(db, {
      paperclipCloudConnector: cloudConnector,
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
      remoteHttpRequest: async (url, init) => fetch(url, init),
    });
    const actor = { actorType: "user" as const, actorId: userId };
    toolsListFetch();
    const connected = await service.connectGalleryApp(company!.id, {
      galleryKey: "gmail", connectionMethodKey: "paperclip-draft", grantKind: "user", name: "Gmail",
    }, actor);
    const started = await service.startOAuth(company!.id, connected.connectionId, {
      redirectUri: "https://paperclip.example/api/tools/oauth/cloud-connector/callback", actor,
    });
    await service.completePaperclipCloudConnectorCallback({
      state: new URL(started.authorizationUrl).searchParams.get("state")!, claimId: "removal-claim", actor,
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board", userId, sessionId: `session-${randomUUID()}`, userName: "Owner", userEmail: null,
        isInstanceAdmin: false, source: "session", companyIds: [company!.id],
        memberships: [{ companyId: company!.id, membershipRole: "owner", status: "active" }],
      };
      next();
    });
    app.use("/api", toolAccessRoutes(db, {
      paperclipCloudConnector: cloudConnector,
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
      remoteHttpRequest: async (url, init) => fetch(url, init),
    }));
    app.use(errorHandler);
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, connected.connectionId));
    return { company: company!, userId, connector, app, connectionId: connected.connectionId, grant: grant! };
  }

  async function liveSecretCount(companyId: string) {
    return (await db.select({ id: companySecrets.id }).from(companySecrets)
      .where(and(eq(companySecrets.companyId, companyId), isNull(companySecrets.deletedAt)))).length;
  }

  it.each([
    ["revoked", "ended"],
    ["other_connections_remain", "other_connections_remain"],
    ["provider_revocation_failed", "not_ended"],
    ["binding_not_known", "not_ended"],
    ["provider_revocation_disabled", "not_ended"],
    ["revocation_in_progress", "not_ended"],
  ] as const)("asks Cloud to end Google access and reports %s as %s", async (outcome, result) => {
    const fixture = await connectManagedGmail();
    fixture.connector.revoke.mockResolvedValue({ outcome });

    const response = await request(fixture.app).delete(`/api/tool-connections/${fixture.connectionId}`);

    expect(response.status).toBe(200);
    expect(fixture.connector.revoke).toHaveBeenCalledTimes(1);
    expect(fixture.connector.revoke).toHaveBeenCalledWith({
      subject: fixture.userId, companyId: fixture.company.id, profile: "gmail.draft", token: REFRESH_TOKEN, timeoutMs: 5_000,
    });
    expect(response.body.removal.providerAccess).toEqual({ provider: "google", result, outcomes: [outcome] });
    const [entry] = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, fixture.company.id), eq(activityLog.action, "tool_connection.archived")));
    expect(entry!.details).toMatchObject({ providerAccess: { provider: "google", result, outcomes: [outcome] } });
    expect(JSON.stringify(entry!.details)).not.toContain(REFRESH_TOKEN);
    expect(await liveSecretCount(fixture.company.id)).toBe(0);
  });

  it.each([
    ["an older broker", new PaperclipCloudConnectorError("rejected", "REAUTHORIZATION_REQUIRED", 409, undefined, "REVOCATION_NOT_AVAILABLE"), "revocation_not_available"],
    ["a broker timeout", new PaperclipCloudConnectorError("Paperclip Cloud connector is unavailable", "CONNECTOR_UNAVAILABLE"), "broker_unavailable"],
    ["a network error", new TypeError("fetch failed"), "broker_error"],
  ] as const)("still removes the connection locally after %s", async (_label, error, outcome) => {
    const fixture = await connectManagedGmail();
    fixture.connector.revoke.mockRejectedValue(error);
    const logged: unknown[] = [];
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
      vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => { logged.push(args); }) as never);
    }

    const response = await request(fixture.app).delete(`/api/tool-connections/${fixture.connectionId}`);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("archived");
    expect(response.body.removal.providerAccess).toEqual({ provider: "google", result: "not_ended", outcomes: [outcome] });
    expect(await liveSecretCount(fixture.company.id)).toBe(0);
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, fixture.connectionId));
    expect(connection!.credentialSecretRefs).toEqual([]);
    expect(JSON.stringify(logged)).not.toContain(REFRESH_TOKEN);
  });

  it("closes local access without waiting for Paperclip Cloud to answer", async () => {
    const fixture = await connectManagedGmail();
    fixture.connector.revoke.mockImplementation(async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const [row] = await db.select({ status: toolConnections.status }).from(toolConnections).where(eq(toolConnections.id, fixture.connectionId));
        if (row?.status === "archived") return { outcome: "revoked" };
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return { outcome: "provider_revocation_failed" };
    });

    const response = await request(fixture.app).delete(`/api/tool-connections/${fixture.connectionId}`);

    expect(response.status).toBe(200);
    expect(response.body.removal.providerAccess.outcomes).toEqual(["revoked"]);
  });

  it("keeps the delete-stored-data option working alongside the Google outcome", async () => {
    const fixture = await connectManagedGmail();

    const response = await request(fixture.app).delete(`/api/tool-connections/${fixture.connectionId}?deleteStoredContent=true`);

    expect(response.status).toBe(200);
    expect(response.body.contentDeletion).toBeTruthy();
    expect(response.body.removal.providerAccess).toEqual({ provider: "google", result: "ended", outcomes: ["revoked"] });
    expect(await liveSecretCount(fixture.company.id)).toBe(0);
  });

  it("revokes only the removed grant at Google and records the outcome", async () => {
    const fixture = await connectManagedGmail();
    fixture.connector.revoke.mockResolvedValue({ outcome: "other_connections_remain" });

    const response = await request(fixture.app).delete(`/api/tool-connections/${fixture.connectionId}/grants/${fixture.grant.id}`);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("revoked");
    expect(response.body.providerAccess).toEqual({ provider: "google", result: "other_connections_remain", outcomes: ["other_connections_remain"] });
    expect(fixture.connector.revoke).toHaveBeenCalledTimes(1);
    expect(fixture.connector.revoke).toHaveBeenCalledWith(expect.objectContaining({ subject: fixture.userId, token: REFRESH_TOKEN }));
    const [entry] = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, fixture.company.id), eq(activityLog.action, "tool_connection.grant_revoked")));
    expect(entry!.details).toMatchObject({ providerAccess: { outcomes: ["other_connections_remain"] } });

    const removal = await request(fixture.app).delete(`/api/tool-connections/${fixture.connectionId}`);
    expect(removal.status).toBe(200);
    expect(fixture.connector.revoke).toHaveBeenCalledTimes(1);
    expect(removal.body.removal.providerAccess).toBeUndefined();
  });
});
