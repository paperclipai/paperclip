import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  companyMemberships,
  companySecrets,
  connectionGrants,
  createDb,
  googlePendingRevocations,
  toolAccessAuditEvents,
  toolConnectionInstalls,
  toolConnections,
} from "@paperclipai/db";
import { and, eq, isNull, ne } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { errorHandler } from "../middleware/index.js";
import { logger } from "../middleware/logger.js";
import { PaperclipCloudConnectorError, type PaperclipCloudConnector } from "../services/paperclip-cloud-connector.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import {
  connectManagedGmail as connectManagedGmailFixture,
  deleteManagedGoogleTestRows,
  liveSecretCount as countLiveSecrets,
  REFRESH_TOKEN,
} from "./helpers/managed-google-connection.js";

vi.mock("../services/google-sign-in-availability.js", () => ({ paperclipGoogleSignInAvailable: () => true }));


const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

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
    vi.unstubAllEnvs();
    await deleteManagedGoogleTestRows(db);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  const connectManagedGmail = (grantKind: "user" | "organization" = "user") => connectManagedGmailFixture(db, grantKind);

  async function googleAudit(connectionId: string) {
    const rows = await db.select().from(toolAccessAuditEvents).where(and(
      eq(toolAccessAuditEvents.connectionId, connectionId), eq(toolAccessAuditEvents.action, "connection.google_access_removal")));
    return rows.map((row) => ({ reasonCode: row.reasonCode, providerAccess: (row.details as Record<string, unknown>).providerAccess }));
  }

  const liveSecretCount = (companyId: string) => countLiveSecrets(db, companyId);

  it.each([
    ["revoked", "ended"],
    ["other_connections_remain", "other_connections_remain"],
    ["provider_revocation_failed", "retrying"],
    ["binding_not_known", "not_ended"],
    ["provider_revocation_disabled", "not_ended"],
    ["revocation_in_progress", "retrying"],
  ] as const)("asks Cloud to end Google access and reports %s as %s", async (outcome, result) => {
    const fixture = await connectManagedGmail();
    fixture.connector.revoke.mockResolvedValue({ outcome });

    const response = await request(fixture.app).delete(`/api/tool-connections/${fixture.connectionId}`);

    expect(response.status).toBe(200);
    expect(fixture.connector.revoke).toHaveBeenCalledTimes(1);
    expect(fixture.connector.revoke).toHaveBeenCalledWith({
      subject: fixture.userId, companyId: fixture.company.id, profile: "gmail.draft", token: REFRESH_TOKEN, timeoutMs: expect.any(Number),
    });
    const [{ timeoutMs }] = fixture.connector.revoke.mock.calls[0] as unknown as [{ timeoutMs: number }];
    expect(timeoutMs).toBeGreaterThan(4_000);
    expect(timeoutMs).toBeLessThanOrEqual(5_000);
    expect(response.body.removal.providerAccess).toEqual({ provider: "google", result, outcomes: [outcome] });
    const [entry] = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, fixture.company.id), eq(activityLog.action, "tool_connection.archived")));
    expect(entry!.details).toMatchObject({ providerAccess: { provider: "google", result, outcomes: [outcome] } });
    expect(JSON.stringify(entry!.details)).not.toContain(REFRESH_TOKEN);
    expect(await liveSecretCount(fixture.company.id)).toBe(0);
    expect(await googleAudit(fixture.connectionId)).toEqual([{ reasonCode: result, providerAccess: { provider: "google", result, outcomes: [outcome] } }]);
  });

  it.each([
    ["revoked", "ended"],
    ["other_connections_remain", "other_connections_remain"],
    ["binding_not_known", "not_ended"],
  ] as const)("records %s for a single grant in the audit history and keeps the existing audit field", async (outcome, result) => {
    const fixture = await connectManagedGmail();
    fixture.connector.revoke.mockResolvedValue({ outcome });

    const response = await request(fixture.app).delete(`/api/tool-connections/${fixture.connectionId}/grants/${fixture.grant.id}`);

    expect(response.status).toBe(200);
    expect(await googleAudit(fixture.connectionId)).toEqual([{ reasonCode: result, providerAccess: { provider: "google", result, outcomes: [outcome] } }]);
    const [revoked] = await db.select().from(toolAccessAuditEvents).where(and(
      eq(toolAccessAuditEvents.connectionId, fixture.connectionId), eq(toolAccessAuditEvents.action, "connection_grant.revoked")));
    expect(revoked!.details).toMatchObject({ providerRevocation: "not_applicable" });
    expect(revoked!.details).not.toHaveProperty("providerAccess");
  });

  it("still removes the connection when the audit record of the Google result cannot be written", async () => {
    const fixture = await connectManagedGmail();
    const insert = db.insert.bind(db);
    vi.spyOn(db, "insert").mockImplementation(((table: unknown) => {
      if (table === toolAccessAuditEvents) throw new Error("audit unavailable");
      return insert(table as never);
    }) as never);

    const response = await request(fixture.app).delete(`/api/tool-connections/${fixture.connectionId}`);

    expect(response.status).toBe(200);
    expect(response.body.removal.providerAccess).toEqual({ provider: "google", result: "ended", outcomes: ["revoked"] });
  });

  it.each([
    ["an older broker", new PaperclipCloudConnectorError("rejected", "REAUTHORIZATION_REQUIRED", 409, undefined, "REVOCATION_NOT_AVAILABLE"), "revocation_not_available", "not_ended"],
    ["a broker timeout", new PaperclipCloudConnectorError("Paperclip Cloud connector is unavailable", "CONNECTOR_UNAVAILABLE"), "broker_unavailable", "retrying"],
    ["a network error", new TypeError("fetch failed"), "broker_error", "retrying"],
  ] as const)("still removes the connection locally after %s", async (_label, error, outcome, result) => {
    const fixture = await connectManagedGmail();
    fixture.connector.revoke.mockRejectedValue(error);
    const logged: unknown[] = [];
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
      vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => { logged.push(args); }) as never);
    }

    const response = await request(fixture.app).delete(`/api/tool-connections/${fixture.connectionId}`);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("archived");
    expect(response.body.removal.providerAccess).toEqual({ provider: "google", result, outcomes: [outcome] });
    expect(await liveSecretCount(fixture.company.id)).toBe(0);
    expect(await db.select().from(googlePendingRevocations)).toHaveLength(result === "retrying" ? 1 : 0);
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, fixture.connectionId));
    expect(connection!.credentialSecretRefs).toEqual([]);
    expect(JSON.stringify(logged)).not.toContain(REFRESH_TOKEN);
  });

  it("ends access at Google only after every local access path is closed", async () => {
    const fixture = await connectManagedGmail();
    const seen: Array<{ connection?: string; grant?: string; installs: number; refreshStored: boolean }> = [];
    const refreshSecretId = fixture.grant.credentialSecretRefs.find((ref) => ref.configPath === "oauth.refresh_token")!.secretId;
    fixture.connector.revoke.mockImplementation(async () => {
      const [row] = await db.select({ status: toolConnections.status, enabled: toolConnections.enabled }).from(toolConnections).where(eq(toolConnections.id, fixture.connectionId));
      const [grantRow] = await db.select({ status: connectionGrants.status }).from(connectionGrants).where(eq(connectionGrants.id, fixture.grant.id));
      const installs = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, fixture.connectionId));
      const [refresh] = await db.select({ id: companySecrets.id }).from(companySecrets).where(and(eq(companySecrets.id, refreshSecretId), isNull(companySecrets.deletedAt)));
      seen.push({ connection: row?.enabled ? row.status : `${row?.status}:disabled`, grant: grantRow?.status, installs: installs.length, refreshStored: Boolean(refresh) });
      return { outcome: "revoked" };
    });

    const response = await request(fixture.app).delete(`/api/tool-connections/${fixture.connectionId}`);

    expect(response.status).toBe(200);
    expect(seen).toEqual([{ connection: "archived:disabled", grant: "revoked", installs: 0, refreshStored: true }]);
    expect(await liveSecretCount(fixture.company.id)).toBe(0);
  });

  it("revokes a single grant at Google only after the grant is marked revoked", async () => {
    const fixture = await connectManagedGmail();
    const seen: Array<string | undefined> = [];
    fixture.connector.revoke.mockImplementation(async () => {
      const [grantRow] = await db.select({ status: connectionGrants.status }).from(connectionGrants).where(eq(connectionGrants.id, fixture.grant.id));
      seen.push(grantRow?.status);
      return { outcome: "revoked" };
    });

    const response = await request(fixture.app).delete(`/api/tool-connections/${fixture.connectionId}/grants/${fixture.grant.id}`);

    expect(response.status).toBe(200);
    expect(seen).toEqual(["revoked"]);
  });

  it("makes no broker call when the local grant revocation fails", async () => {
    const fixture = await connectManagedGmail();
    vi.spyOn(db, "transaction").mockRejectedValue(new Error("local removal failed"));

    const response = await request(fixture.app).delete(`/api/tool-connections/${fixture.connectionId}/grants/${fixture.grant.id}`);

    expect(response.status).toBe(500);
    expect(fixture.connector.revoke).not.toHaveBeenCalled();
  });

  it("makes no broker call when the teardown fails, keeps the token, and the retry sends it once", async () => {
    const fixture = await connectManagedGmail();
    const transaction = vi.spyOn(db, "transaction").mockRejectedValue(new Error("teardown failed"));

    const failed = await request(fixture.app).delete(`/api/tool-connections/${fixture.connectionId}`);
    expect(failed.status).toBe(500);
    expect(fixture.connector.revoke).not.toHaveBeenCalled();
    expect(await liveSecretCount(fixture.company.id)).toBeGreaterThan(0);

    transaction.mockRestore();
    const retried = await request(fixture.app).delete(`/api/tool-connections/${fixture.connectionId}`);
    expect(retried.status).toBe(200);
    expect(fixture.connector.revoke).toHaveBeenCalledTimes(1);
    expect(retried.body.removal.providerAccess).toEqual({ provider: "google", result: "ended", outcomes: ["revoked"] });
    expect(await liveSecretCount(fixture.company.id)).toBe(0);

    const again = await request(fixture.app).delete(`/api/tool-connections/${fixture.connectionId}`);
    expect(again.status).toBe(200);
    expect(fixture.connector.revoke).toHaveBeenCalledTimes(1);
  });

  it("sends a revocation still owed when the process stopped after the teardown and before the call", async () => {
    const fixture = await connectManagedGmail();
    await db.update(connectionGrants).set({ status: "revoked", revokedAt: new Date() }).where(eq(connectionGrants.id, fixture.grant.id));
    await db.update(toolConnections).set({ status: "archived", enabled: false }).where(eq(toolConnections.id, fixture.connectionId));

    const response = await request(fixture.app).delete(`/api/tool-connections/${fixture.connectionId}`);

    expect(response.status).toBe(200);
    expect(fixture.connector.revoke).toHaveBeenCalledTimes(1);
    expect(await liveSecretCount(fixture.company.id)).toBe(0);
  });

  it("sends a revocation still owed when the process stopped after the grants were revoked", async () => {
    const fixture = await connectManagedGmail();
    await db.update(connectionGrants).set({ status: "revoked", revokedAt: new Date() }).where(eq(connectionGrants.id, fixture.grant.id));
    const seen: number[] = [];
    fixture.connector.revoke.mockImplementation(async () => {
      seen.push(await liveSecretCount(fixture.company.id));
      return { outcome: "revoked" };
    });
    const logged: unknown[] = [];
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
      vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => { logged.push(args); }) as never);
    }

    const response = await request(fixture.app).delete(`/api/tool-connections/${fixture.connectionId}`);

    expect(response.status).toBe(200);
    expect(fixture.connector.revoke).toHaveBeenCalledTimes(1);
    expect(fixture.connector.revoke).toHaveBeenCalledWith(expect.objectContaining({ token: REFRESH_TOKEN }));
    expect(seen[0]).toBeGreaterThan(0);
    expect(await liveSecretCount(fixture.company.id)).toBe(0);
    expect(response.body.removal.providerAccess).toEqual({ provider: "google", result: "ended", outcomes: ["revoked"] });
    expect(await googleAudit(fixture.connectionId)).toEqual([{ reasonCode: "ended", providerAccess: { provider: "google", result: "ended", outcomes: ["revoked"] } }]);
    expect(JSON.stringify(logged)).not.toContain(REFRESH_TOKEN);
  });

  it("makes no broker call when removal fails before the grants are revoked, and the retry sends them", async () => {
    const fixture = await connectManagedGmail();
    const update = db.update.bind(db);
    let failedOnce = false;
    vi.spyOn(db, "update").mockImplementation(((table: unknown) => {
      if (table === connectionGrants && !failedOnce) {
        failedOnce = true;
        throw new Error("grant revocation failed");
      }
      return update(table as never);
    }) as never);

    const failed = await request(fixture.app).delete(`/api/tool-connections/${fixture.connectionId}`);
    expect(failed.status).toBe(500);
    expect(fixture.connector.revoke).not.toHaveBeenCalled();

    const retried = await request(fixture.app).delete(`/api/tool-connections/${fixture.connectionId}`);
    expect(retried.status).toBe(200);
    expect(fixture.connector.revoke).toHaveBeenCalledTimes(1);
    expect(fixture.connector.revoke).toHaveBeenCalledWith(expect.objectContaining({ token: REFRESH_TOKEN }));
    expect(retried.body.removal.providerAccess).toEqual({ provider: "google", result: "ended", outcomes: ["revoked"] });
  });

  it.each(["connection", "grant"] as const)("still completes the local %s removal when the Paperclip Cloud client cannot be created", async (path) => {
    const fixture = await connectManagedGmail();
    vi.stubEnv("PAPERCLIP_ID_CONNECTOR_INSTANCE_ID", "legacy-instance");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board", userId: fixture.userId, sessionId: `session-${randomUUID()}`, userName: "Owner", userEmail: null,
        isInstanceAdmin: false, source: "session", companyIds: [fixture.company.id],
        memberships: [{ companyId: fixture.company.id, membershipRole: "owner", status: "active" }],
      };
      next();
    });
    app.use("/api", toolAccessRoutes(db, {
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
      remoteHttpRequest: async (url, init) => fetch(url, init),
    }));
    app.use(errorHandler);

    const response = await request(app).delete(path === "connection"
      ? `/api/tool-connections/${fixture.connectionId}`
      : `/api/tool-connections/${fixture.connectionId}/grants/${fixture.grant.id}`);

    expect(response.status).toBe(200);
    const providerAccess = path === "connection" ? response.body.removal.providerAccess : response.body.providerAccess;
    expect(providerAccess).toEqual({ provider: "google", result: "retrying", outcomes: ["broker_unavailable"] });
    const [grantRow] = await db.select({ status: connectionGrants.status }).from(connectionGrants).where(eq(connectionGrants.id, fixture.grant.id));
    expect(grantRow!.status).toBe("revoked");
  });

  it("revokes an organization grant under the user who consented after the connection-wide subject changed", async () => {
    const fixture = await connectManagedGmail("organization");
    expect(fixture.grant.kind).toBe("organization");
    const otherUserId = `google-removal-other-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId: fixture.company.id, principalType: "user", principalId: otherUserId, status: "active", membershipRole: "owner",
    });
    const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, fixture.connectionId));
    const config = { ...row!.config, oauth: { ...(row!.config.oauth as Record<string, unknown>), connectorSubjectUserId: otherUserId } };
    await db.update(toolConnections).set({ config, transportConfig: config }).where(eq(toolConnections.id, fixture.connectionId));

    const response = await request(fixture.app).delete(`/api/tool-connections/${fixture.connectionId}`);

    expect(response.status).toBe(200);
    const sent = fixture.connector.revoke.mock.calls.map(([values]) => [values.subject, values.token]);
    expect(sent).toEqual([[fixture.userId, REFRESH_TOKEN]]);
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
    expect(await googleAudit(fixture.connectionId)).toEqual([
      { reasonCode: "other_connections_remain", providerAccess: { provider: "google", result: "other_connections_remain", outcomes: ["other_connections_remain"] } },
    ]);

    const repeated = await request(fixture.app).delete(`/api/tool-connections/${fixture.connectionId}/grants/${fixture.grant.id}`);
    expect(repeated.status).toBe(200);
    expect(fixture.connector.revoke).toHaveBeenCalledTimes(1);

    const removal = await request(fixture.app).delete(`/api/tool-connections/${fixture.connectionId}`);
    expect(removal.status).toBe(200);
    expect(fixture.connector.revoke).toHaveBeenCalledTimes(1);
    expect(removal.body.removal.providerAccess).toBeUndefined();
    expect(await liveSecretCount(fixture.company.id)).toBe(0);
  });

  async function signInAgain(fixture: Awaited<ReturnType<typeof connectManagedGmail>>, refreshToken: string | null) {
    const actor = { actorType: "user" as const, actorId: fixture.userId };
    const started = await fixture.service.startOAuth(fixture.company.id, fixture.connectionId, {
      redirectUri: "https://paperclip.example/api/tools/oauth/cloud-connector/callback", actor,
    });
    const claimed = await fixture.connector.claim({ subject: fixture.userId });
    fixture.connector.claim.mockResolvedValueOnce({ ...claimed, refreshToken } as typeof claimed);
    return () => fixture.service.completePaperclipCloudConnectorCallback({
      state: new URL(started.authorizationUrl).searchParams.get("state")!, claimId: `again-${randomUUID()}`, actor,
    });
  }

  it.each(["connection", "grant"] as const)("deletes the sent token at the secret provider on %s removal", async (path) => {
    const fixture = await connectManagedGmail();
    const refreshSecretId = fixture.grant.credentialSecretRefs.find((ref) => ref.configPath === "oauth.refresh_token")!.secretId;
    const [refresh] = await db.select({ key: companySecrets.key, provider: companySecrets.provider }).from(companySecrets).where(eq(companySecrets.id, refreshSecretId));
    expect(refresh!.provider).toBe("local_encrypted");
    const providerDelete = vi.spyOn(localEncryptedProvider, "deleteOrArchive");

    const response = await request(fixture.app).delete(path === "connection"
      ? `/api/tool-connections/${fixture.connectionId}`
      : `/api/tool-connections/${fixture.connectionId}/grants/${fixture.grant.id}`);

    expect(response.status).toBe(200);
    const deletedKeys = providerDelete.mock.calls.map(([input]) => (input as { context: { secretKey: string } }).context.secretKey);
    expect(deletedKeys.filter((key) => key.startsWith(refresh!.key))).toHaveLength(1);
    const [row] = await db.select({ id: companySecrets.id }).from(companySecrets).where(eq(companySecrets.id, refreshSecretId));
    expect(row).toBeUndefined();
    if (path === "connection") expect(response.body.removal.secretsRevoked).toBe(2);
  });

  it.each(["connection", "grant"] as const)("completes a %s removal on a database pool of one connection", async (path) => {
    const fixture = await connectManagedGmail();
    const single = createDb(tempDb!.connectionString, { maxConnections: 1 });
    try {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.actor = {
          type: "board", userId: fixture.userId, sessionId: `session-${randomUUID()}`, userName: "Owner", userEmail: null,
          isInstanceAdmin: false, source: "session", companyIds: [fixture.company.id],
          memberships: [{ companyId: fixture.company.id, membershipRole: "owner", status: "active" }],
        };
        next();
      });
      app.use("/api", toolAccessRoutes(single, {
        paperclipCloudConnector: fixture.connector as unknown as PaperclipCloudConnector,
        remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
        remoteHttpRequest: async (url, init) => fetch(url, init),
      }));
      app.use(errorHandler);
      const url = path === "connection"
        ? `/api/tool-connections/${fixture.connectionId}`
        : `/api/tool-connections/${fixture.connectionId}/grants/${fixture.grant.id}`;
      const outcome = await Promise.race([
        request(app).delete(url).then((response) => response.status),
        new Promise((resolve) => setTimeout(() => resolve("timed out"), 15_000)),
      ]);
      expect(outcome).toBe(200);
      expect(fixture.connector.revoke).toHaveBeenCalledTimes(1);
      const refreshSecretId = fixture.grant.credentialSecretRefs.find((ref) => ref.configPath === "oauth.refresh_token")!.secretId;
      const [refresh] = await db.select({ id: companySecrets.id }).from(companySecrets).where(and(eq(companySecrets.id, refreshSecretId), isNull(companySecrets.deletedAt)));
      expect(refresh).toBeUndefined();
    } finally {
      await single.$client.end({ timeout: 1 });
    }
  }, 30_000);

  it("keeps the new token when the user signs in again while Paperclip Cloud answers a grant removal", async () => {
    const fixture = await connectManagedGmail();
    let finishSignIn: (() => Promise<unknown>) | null = null;
    fixture.connector.revoke.mockImplementation(async () => {
      await finishSignIn!();
      return { outcome: "revoked" };
    });
    finishSignIn = await signInAgain(fixture, "fresh-refresh-token-do-not-log");

    const response = await request(fixture.app).delete(`/api/tool-connections/${fixture.connectionId}/grants/${fixture.grant.id}`);

    expect(response.status).toBe(200);
    const [grantRow] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, fixture.grant.id));
    expect(grantRow!.status).toBe("active");
    fixture.connector.refresh.mockClear();
    await fixture.service.refreshOAuthGrantCredentials({
      companyId: fixture.company.id, connectionId: fixture.connectionId, grantId: fixture.grant.id, forceRefresh: true,
      actor: { actorType: "user", actorId: fixture.userId },
    });
    expect(fixture.connector.refresh).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: "fresh-refresh-token-do-not-log" }));
  });

  async function liveRefsToMissingSecrets(companyId: string) {
    const live = new Set((await db.select({ id: companySecrets.id }).from(companySecrets)
      .where(and(eq(companySecrets.companyId, companyId), isNull(companySecrets.deletedAt)))).map((row) => row.id));
    const grants = await db.select().from(connectionGrants).where(and(eq(connectionGrants.companyId, companyId), ne(connectionGrants.status, "revoked")));
    const connections = await db.select().from(toolConnections).where(and(eq(toolConnections.companyId, companyId), ne(toolConnections.status, "archived")));
    return [
      ...grants.flatMap((grant) => grant.credentialSecretRefs),
      ...connections.flatMap((connection) => [...connection.credentialSecretRefs, ...connection.credentialRefs]),
    ].filter((ref) => !live.has(ref.secretId));
  }

  it("refuses a managed Google sign-in that returns no refresh token and leaves the grant unchanged", async () => {
    const fixture = await connectManagedGmail();

    await expect((await signInAgain(fixture, null))()).rejects.toMatchObject({ details: { code: "oauth_refresh_missing" } });

    const [grantRow] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, fixture.grant.id));
    expect(grantRow!.status).toBe("active");
    expect(grantRow!.credentialSecretRefs).toEqual(fixture.grant.credentialSecretRefs);
    expect(await liveRefsToMissingSecrets(fixture.company.id)).toEqual([]);
  });

  it("still deletes the old refresh token when a sign-in without one is refused while Paperclip Cloud answers a grant removal", async () => {
    const fixture = await connectManagedGmail();
    const oldRefreshId = fixture.grant.credentialSecretRefs.find((ref) => ref.configPath === "oauth.refresh_token")!.secretId;
    const finishSignIn = await signInAgain(fixture, null);
    let signIn: unknown = null;
    fixture.connector.revoke.mockImplementation(async () => {
      signIn = await finishSignIn().then(() => "completed", (error: { details?: { code?: string } }) => error.details?.code);
      return { outcome: "revoked" };
    });

    const response = await request(fixture.app).delete(`/api/tool-connections/${fixture.connectionId}/grants/${fixture.grant.id}`);

    expect(response.status).toBe(200);
    expect(signIn).toBe("oauth_refresh_missing");
    const [grantRow] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, fixture.grant.id));
    expect(grantRow!.status).toBe("revoked");
    const [oldRefresh] = await db.select({ id: companySecrets.id }).from(companySecrets).where(eq(companySecrets.id, oldRefreshId));
    expect(oldRefresh).toBeUndefined();
    expect(await liveRefsToMissingSecrets(fixture.company.id)).toEqual([]);
  });

  it("refuses a sign-in for a connection that was removed while Paperclip Cloud answered", async () => {
    const fixture = await connectManagedGmail();
    const finishSignIn = await signInAgain(fixture, "late-refresh-token-do-not-log");
    let lateSignIn: unknown = null;
    fixture.connector.revoke.mockImplementation(async () => {
      lateSignIn = await finishSignIn().then(() => "completed", () => "refused");
      return { outcome: "revoked" };
    });

    const response = await request(fixture.app).delete(`/api/tool-connections/${fixture.connectionId}`);

    expect(response.status).toBe(200);
    expect(lateSignIn).toBe("refused");
    expect(await liveSecretCount(fixture.company.id)).toBe(0);
  });

  it("sends the new token of a grant that was signed in again after an owed revocation", async () => {
    const fixture = await connectManagedGmail();
    await db.update(connectionGrants).set({ status: "revoked", revokedAt: new Date() }).where(eq(connectionGrants.id, fixture.grant.id));
    await (await signInAgain(fixture, "renewed-refresh-token-do-not-log"))();
    const [grantRow] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, fixture.grant.id));
    expect(grantRow!.status).toBe("active");

    const response = await request(fixture.app).delete(`/api/tool-connections/${fixture.connectionId}`);

    expect(response.status).toBe(200);
    expect(fixture.connector.revoke).toHaveBeenCalledTimes(1);
    expect(fixture.connector.revoke).toHaveBeenCalledWith(expect.objectContaining({ token: "renewed-refresh-token-do-not-log" }));
  });

  it("keeps the refresh token when its version changes while Paperclip Cloud answers", async () => {
    const fixture = await connectManagedGmail();
    const refreshSecretId = fixture.grant.credentialSecretRefs.find((ref) => ref.configPath === "oauth.refresh_token")!.secretId;
    fixture.connector.revoke.mockImplementation(async () => {
      const [row] = await db.select({ latestVersion: companySecrets.latestVersion }).from(companySecrets).where(eq(companySecrets.id, refreshSecretId));
      await db.update(companySecrets).set({ latestVersion: row!.latestVersion + 1 }).where(eq(companySecrets.id, refreshSecretId));
      return { outcome: "revoked" };
    });

    const response = await request(fixture.app).delete(`/api/tool-connections/${fixture.connectionId}/grants/${fixture.grant.id}`);

    expect(response.status).toBe(200);
    const [refresh] = await db.select({ id: companySecrets.id }).from(companySecrets).where(and(eq(companySecrets.id, refreshSecretId), isNull(companySecrets.deletedAt)));
    expect(refresh).toBeTruthy();
  });

  it("neither ends access at Google nor deletes the token when revoking an organization grant the connection still uses", async () => {
    const fixture = await connectManagedGmail("organization");
    const refreshSecretId = fixture.grant.credentialSecretRefs.find((ref) => ref.configPath === "oauth.refresh_token")!.secretId;
    const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, fixture.connectionId));
    const shared = [...row!.credentialSecretRefs, ...row!.credentialRefs].some((ref) => ref.secretId === refreshSecretId);
    expect(shared).toBe(true);

    const response = await request(fixture.app).delete(`/api/tool-connections/${fixture.connectionId}/grants/${fixture.grant.id}`);
    expect(response.status).toBe(200);
    expect(response.body.providerAccess).toBeUndefined();
    expect(fixture.connector.revoke).not.toHaveBeenCalled();
    const [refresh] = await db.select({ id: companySecrets.id }).from(companySecrets).where(and(eq(companySecrets.id, refreshSecretId), isNull(companySecrets.deletedAt)));
    expect(refresh).toBeTruthy();

    const removal = await request(fixture.app).delete(`/api/tool-connections/${fixture.connectionId}`);
    expect(removal.status).toBe(200);
    expect(fixture.connector.revoke).toHaveBeenCalledTimes(1);
    expect(await liveSecretCount(fixture.company.id)).toBe(0);
  });
});
