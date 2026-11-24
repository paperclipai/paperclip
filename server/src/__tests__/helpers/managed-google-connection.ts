import { randomUUID } from "node:crypto";
import express from "express";
import { vi } from "vitest";
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
  googlePendingRevocations,
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
  type Db,
} from "@paperclipai/db";
import { and, eq, isNull } from "drizzle-orm";
import { GOOGLE_WORKSPACE_CONNECTOR_PROFILES } from "@paperclipai/shared";
import { toolAccessService } from "../../services/tool-access.js";
import { toolAccessRoutes } from "../../routes/tool-access.js";
import { errorHandler } from "../../middleware/index.js";
import type { PaperclipCloudConnector } from "../../services/paperclip-cloud-connector.js";

export const REFRESH_TOKEN = "gmail-refresh-token-do-not-log";

export function fakeConnector(companyId: string, userId: string) {
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
    claim: vi.fn(async ({ subject }: { subject: string }) => subject === userId
      ? credentials
      : { ...credentials, subject, refreshToken: `${subject}-refresh-do-not-log`, accessToken: `${subject}-access` }),
    refresh: vi.fn(async () => credentials),
    revoke: vi.fn(async (_values: { subject: string; token: string }): Promise<{ outcome?: string }> => ({ outcome: "revoked" })),
  };
}

export function toolsListFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    return Response.json({ jsonrpc: "2.0", id: body.id,
      result: body.method === "initialize" ? { protocolVersion: "2025-06-18" } : { tools: [] } });
  });
}

export async function connectManagedGmail(db: Db, grantKind: "user" | "organization" = "user") {
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
    galleryKey: "gmail", connectionMethodKey: "paperclip-draft", grantKind, name: "Gmail",
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
  return { company: company!, userId, connector, app, service, connectionId: connected.connectionId, grant: grant! };
}

export async function liveSecretCount(db: Db, companyId: string) {
  return (await db.select({ id: companySecrets.id }).from(companySecrets)
    .where(and(eq(companySecrets.companyId, companyId), isNull(companySecrets.deletedAt)))).length;
}

export async function deleteManagedGoogleTestRows(db: Db) {
  await db.delete(toolConnectionContentDeletions);
  await db.delete(googlePendingRevocations);
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
}
