import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  companies,
  companySecrets,
  connectionGrants,
  createDb,
  googlePendingRevocations,
  toolAccessAuditEvents,
  toolConnections,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  connectManagedGmail as connectManagedGmailFixture,
  deleteManagedGoogleTestRows,
  fakeConnector,
  liveSecretCount as countLiveSecrets,
  REFRESH_TOKEN,
} from "./helpers/managed-google-connection.js";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { errorHandler } from "../middleware/index.js";
import { PaperclipCloudConnectorError, type PaperclipCloudConnector } from "../services/paperclip-cloud-connector.js";
import {
  createGooglePendingRevocation,
  GOOGLE_REVOCATION_LIFETIME_MS,
  googleRevocationRetryDelayMs,
  queueGoogleRevocationFromSecret,
  revokeGoogleAccessForRemovedInstance,
} from "../services/tool-access/connections/google-pending-revocation.js";
import { secretService } from "../services/secrets.js";
import { deleteCompany } from "../services/company-deletion.js";
import { listConnectionLifecycleEvents } from "../services/tool-connection-activity.js";

vi.mock("../services/google-sign-in-availability.js", () => ({ paperclipGoogleSignInAvailable: () => true }));

vi.mock("../services/paperclip-cloud-connector-status.js", () => ({
  reconcilePaperclipCloudConnectorEnrollmentStatus: async (_env: unknown, _request: unknown, onRemoved?: () => Promise<unknown>) => {
    await onRemoved?.();
    return { configured: false, status: "not_configured", brokerBaseUrl: "https://broker.example", instanceId: null, environment: "development", origins: [] };
  },
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("retrying an unconfirmed Google access removal", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-google-retry-");
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
  const liveSecretCount = (companyId: string) => countLiveSecrets(db, companyId);

  function worker(connector: ReturnType<typeof fakeConnector>, at: () => number) {
    return createGooglePendingRevocation(db, { currentCloudConnector: () => connector as unknown as PaperclipCloudConnector, now: at });
  }

  async function drain(connector: ReturnType<typeof fakeConnector>, at: number) {
    await worker(connector, () => at).drain(new AbortController().signal);
  }

  async function retryAudit(companyId: string) {
    const rows = await db.select().from(toolAccessAuditEvents).where(and(
      eq(toolAccessAuditEvents.companyId, companyId), eq(toolAccessAuditEvents.action, "connection.google_access_retry")));
    return rows.map((row) => ({ outcome: row.outcome, reasonCode: row.reasonCode }));
  }

  async function retryActivity(companyId: string) {
    const rows = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    return rows.filter((row) => row.action.startsWith("tool_connection.google_access_")).map((row) => row.action);
  }

  it("keeps an unconfirmed token only in the pending record, encrypted, and retries until Google confirms", async () => {
    const fixture = await connectManagedGmail();
    fixture.connector.revoke.mockResolvedValueOnce({ outcome: "provider_revocation_failed" });
    const startedAt = Date.now();

    const response = await request(fixture.app).delete(`/api/tool-connections/${fixture.connectionId}`);

    expect(response.status).toBe(200);
    expect(response.body.removal.providerAccess).toEqual({ provider: "google", result: "retrying", outcomes: ["provider_revocation_failed"] });
    expect(await liveSecretCount(fixture.company.id)).toBe(0);
    const [pending] = await db.select().from(googlePendingRevocations);
    expect(pending).toMatchObject({ companyId: fixture.company.id, connectionId: fixture.connectionId, grantId: fixture.grant.id,
      subject: fixture.userId, profile: "gmail.draft", reason: "connection_removed", attempts: 1, lastOutcome: "provider_revocation_failed" });
    expect(JSON.stringify(pending)).not.toContain(REFRESH_TOKEN);
    expect(pending!.nextAttemptAt.getTime() - startedAt).toBeGreaterThanOrEqual(50_000);
    expect(pending!.giveUpAt.getTime() - pending!.createdAt.getTime()).toBe(GOOGLE_REVOCATION_LIFETIME_MS);
    const listed = await secretService(db).list(fixture.company.id);
    expect(JSON.stringify(listed)).not.toContain(REFRESH_TOKEN);

    await drain(fixture.connector, startedAt + 10_000);
    expect(fixture.connector.revoke).toHaveBeenCalledTimes(1);

    fixture.connector.revoke.mockResolvedValueOnce({ outcome: "revocation_in_progress" });
    await drain(fixture.connector, pending!.nextAttemptAt.getTime());
    expect(fixture.connector.revoke).toHaveBeenCalledTimes(2);
    const [second] = await db.select().from(googlePendingRevocations);
    expect(second).toMatchObject({ attempts: 2, lastOutcome: "revocation_in_progress" });

    fixture.connector.revoke.mockResolvedValueOnce({ outcome: "revoked" });
    await drain(fixture.connector, second!.nextAttemptAt.getTime());
    expect(fixture.connector.revoke).toHaveBeenLastCalledWith(expect.objectContaining({
      subject: fixture.userId, companyId: fixture.company.id, profile: "gmail.draft", token: REFRESH_TOKEN }));
    expect(await db.select().from(googlePendingRevocations)).toEqual([]);
    expect(await retryAudit(fixture.company.id)).toEqual([{ outcome: "success", reasonCode: "ended" }]);
    expect(await retryActivity(fixture.company.id)).toEqual(["tool_connection.google_access_ended"]);
    const lifecycle = await listConnectionLifecycleEvents(db, { companyId: fixture.company.id, connectionIds: [fixture.connectionId], limit: 50 });
    expect(lifecycle.map((event) => event.type)).toContain("google_access_ended");
  });

  it("keeps the token before calling Cloud, so a restart during the call still revokes it", async () => {
    const fixture = await connectManagedGmail();
    let queuedDuringCall = 0;
    fixture.connector.revoke.mockImplementationOnce(async () => {
      queuedDuringCall = (await db.select().from(googlePendingRevocations)).length;
      throw new PaperclipCloudConnectorError("Paperclip Cloud connector is unavailable", "CONNECTOR_UNAVAILABLE");
    });

    await request(fixture.app).delete(`/api/tool-connections/${fixture.connectionId}/grants/${fixture.grant.id}`);

    expect(queuedDuringCall).toBe(1);
    await db.update(googlePendingRevocations).set({ attempts: 0, nextAttemptAt: new Date(Date.now() + 120_000) });
    const fresh = fakeConnector(fixture.company.id, fixture.userId);
    await drain(fresh, Date.now() + 130_000);
    expect(fresh.revoke).toHaveBeenCalledWith(expect.objectContaining({ token: REFRESH_TOKEN, subject: fixture.userId }));
    expect(await db.select().from(googlePendingRevocations)).toEqual([]);
  });

  it.each(["binding_not_known", "other_connections_remain", "provider_revocation_disabled"] as const)(
    "stops retrying and deletes the token when Cloud answers %s", async (outcome) => {
      const fixture = await connectManagedGmail();
      fixture.connector.revoke.mockResolvedValueOnce({ outcome: "provider_revocation_failed" });
      await request(fixture.app).delete(`/api/tool-connections/${fixture.connectionId}`);
      const [pending] = await db.select().from(googlePendingRevocations);

      fixture.connector.revoke.mockResolvedValueOnce({ outcome });
      await drain(fixture.connector, pending!.nextAttemptAt.getTime());

      expect(await db.select().from(googlePendingRevocations)).toEqual([]);
      const result = outcome === "other_connections_remain" ? "other_connections_remain" : "not_ended";
      expect(await retryAudit(fixture.company.id)).toEqual([{ outcome: result === "not_ended" ? "failure" : "success", reasonCode: result }]);
      expect(await retryActivity(fixture.company.id)).toEqual(["tool_connection.google_access_not_ended"]);
    });

  it("backs off from one minute to six hours and gives up after 30 days with a final entry", async () => {
    expect([1, 2, 3, 9, 10, 50].map(googleRevocationRetryDelayMs)).toEqual([60_000, 120_000, 240_000, 15_360_000, 21_600_000, 21_600_000]);
    const fixture = await connectManagedGmail();
    fixture.connector.revoke.mockResolvedValue({ outcome: "provider_revocation_failed" });
    await request(fixture.app).delete(`/api/tool-connections/${fixture.connectionId}`);
    const [pending] = await db.select().from(googlePendingRevocations);

    await drain(fixture.connector, pending!.giveUpAt.getTime() - 1_000);
    const [last] = await db.select().from(googlePendingRevocations);
    expect(last!.nextAttemptAt.getTime()).toBe(pending!.giveUpAt.getTime());
    const calls = fixture.connector.revoke.mock.calls.length;

    await drain(fixture.connector, pending!.giveUpAt.getTime());
    expect(fixture.connector.revoke).toHaveBeenCalledTimes(calls);
    expect(await db.select().from(googlePendingRevocations)).toEqual([]);
    expect(await retryAudit(fixture.company.id)).toEqual([{ outcome: "failure", reasonCode: "gave_up" }]);
    expect(await retryActivity(fixture.company.id)).toEqual(["tool_connection.google_access_not_ended"]);
  });

  it("keeps retrying past an unused copy of the token, and stops without revoking once a live connection uses it", async () => {
    const fixture = await connectManagedGmail();
    fixture.connector.revoke.mockResolvedValueOnce({ outcome: "broker_error" });
    await request(fixture.app).delete(`/api/tool-connections/${fixture.connectionId}`);
    const [pending] = await db.select().from(googlePendingRevocations);
    const copy = await secretService(db).create(fixture.company.id, { name: "Copied token", key: "copied_token", provider: "local_encrypted", value: REFRESH_TOKEN });

    fixture.connector.revoke.mockResolvedValueOnce({ outcome: "broker_error" });
    await drain(fixture.connector, pending!.nextAttemptAt.getTime());
    expect(fixture.connector.revoke).toHaveBeenCalledTimes(2);
    const [unreferenced] = await db.select().from(googlePendingRevocations);
    expect(unreferenced).toMatchObject({ attempts: 2 });

    await db.update(toolConnections).set({ status: "active", credentialSecretRefs: [{ secretId: copy.id, versionSelector: "latest", configPath: "oauth.refresh_token", required: false, label: "Refresh" }] as never })
      .where(eq(toolConnections.id, fixture.connectionId));
    await drain(fixture.connector, unreferenced!.nextAttemptAt.getTime());

    expect(fixture.connector.revoke).toHaveBeenCalledTimes(2);
    expect(await db.select().from(googlePendingRevocations)).toEqual([]);
    expect(await retryAudit(fixture.company.id)).toEqual([{ outcome: "success", reasonCode: "other_connections_remain" }]);
  });

  it("still revokes when the process stopped before the removed grant's own secret was deleted", async () => {
    const fixture = await connectManagedGmail();
    const refreshSecretId = fixture.grant.credentialSecretRefs.find((ref) => ref.configPath === "oauth.refresh_token")!.secretId;
    const [secret] = await db.select({ latestVersion: companySecrets.latestVersion }).from(companySecrets).where(eq(companySecrets.id, refreshSecretId));
    await db.update(connectionGrants).set({ status: "revoked", revokedAt: new Date() }).where(eq(connectionGrants.id, fixture.grant.id));
    await queueGoogleRevocationFromSecret(db, {
      companyId: fixture.company.id, connectionId: fixture.connectionId, grantId: fixture.grant.id, subject: fixture.userId,
      profile: "gmail.draft", secretId: refreshSecretId, version: secret!.latestVersion, reason: "grant_revoked",
    });
    const [pending] = await db.select().from(googlePendingRevocations);
    expect(pending!.sourceSecretId).toBe(refreshSecretId);

    await drain(fixture.connector, pending!.nextAttemptAt.getTime());

    expect(fixture.connector.revoke).toHaveBeenCalledWith(expect.objectContaining({ token: REFRESH_TOKEN }));
    expect(await db.select().from(googlePendingRevocations)).toEqual([]);
    expect(await retryAudit(fixture.company.id)).toEqual([{ outcome: "success", reasonCode: "ended" }]);
  });

  it("stops without revoking when the grant was signed in again and its own secret holds the same token", async () => {
    const fixture = await connectManagedGmail();
    const refreshSecretId = fixture.grant.credentialSecretRefs.find((ref) => ref.configPath === "oauth.refresh_token")!.secretId;
    const [secret] = await db.select({ latestVersion: companySecrets.latestVersion }).from(companySecrets).where(eq(companySecrets.id, refreshSecretId));
    await queueGoogleRevocationFromSecret(db, {
      companyId: fixture.company.id, connectionId: fixture.connectionId, grantId: fixture.grant.id, subject: fixture.userId,
      profile: "gmail.draft", secretId: refreshSecretId, version: secret!.latestVersion, reason: "grant_revoked",
    });
    const [pending] = await db.select().from(googlePendingRevocations);

    await drain(fixture.connector, pending!.nextAttemptAt.getTime());

    expect(fixture.connector.revoke).not.toHaveBeenCalled();
    expect(await db.select().from(googlePendingRevocations)).toEqual([]);
    expect(await retryAudit(fixture.company.id)).toEqual([{ outcome: "success", reasonCode: "other_connections_remain" }]);
  });

  it("keeps the token version that was sent when the grant pins an older version", async () => {
    const fixture = await connectManagedGmail();
    const refreshRef = fixture.grant.credentialSecretRefs.find((ref) => ref.configPath === "oauth.refresh_token")!;
    const [secret] = await db.select({ latestVersion: companySecrets.latestVersion }).from(companySecrets).where(eq(companySecrets.id, refreshRef.secretId));
    await secretService(db).rotate(refreshRef.secretId, { value: "newer-refresh-token-do-not-log" });
    await db.update(connectionGrants).set({
      credentialSecretRefs: fixture.grant.credentialSecretRefs.map((ref) => ref.secretId === refreshRef.secretId ? { ...ref, versionSelector: secret!.latestVersion } : ref),
    }).where(eq(connectionGrants.id, fixture.grant.id));
    fixture.connector.revoke.mockResolvedValueOnce({ outcome: "broker_error" });

    await request(fixture.app).delete(`/api/tool-connections/${fixture.connectionId}/grants/${fixture.grant.id}`);

    expect(fixture.connector.revoke).toHaveBeenLastCalledWith(expect.objectContaining({ token: REFRESH_TOKEN }));
    const [pending] = await db.select().from(googlePendingRevocations);
    fixture.connector.revoke.mockResolvedValueOnce({ outcome: "revoked" });
    await drain(fixture.connector, pending!.nextAttemptAt.getTime());
    expect(fixture.connector.revoke).toHaveBeenLastCalledWith(expect.objectContaining({ token: REFRESH_TOKEN }));
  });

  it("saves the removed instance's revocations before dropping any token, and overlapping sweeps queue each token once", async () => {
    const fixture = await connectManagedGmail();
    const failing = vi.fn(async () => { throw new Error("stopped before the token was dropped"); });

    await Promise.all([
      revokeGoogleAccessForRemovedInstance(db, failing),
      revokeGoogleAccessForRemovedInstance(db, failing),
    ]);

    expect(await db.select().from(googlePendingRevocations)).toHaveLength(1);
    await drain(fixture.connector, Date.now());
    expect(fixture.connector.revoke).toHaveBeenCalledTimes(1);
    expect(fixture.connector.revoke).toHaveBeenCalledWith(expect.objectContaining({ token: REFRESH_TOKEN }));
  });

  it.each([
    ["a board member", false, 0],
    ["an instance admin", true, 1],
  ] as const)("starts the removed-instance cleanup from the status check only for %s", async (_label, isInstanceAdmin, rows) => {
    const fixture = await connectManagedGmail();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board", userId: fixture.userId, sessionId: `session-${randomUUID()}`, userName: "Owner", userEmail: null,
        isInstanceAdmin, source: "session", companyIds: [fixture.company.id],
        memberships: [{ companyId: fixture.company.id, membershipRole: "owner", status: "active" }],
      };
      next();
    });
    app.use("/api", toolAccessRoutes(db, { paperclipCloudConnector: fixture.connector as unknown as PaperclipCloudConnector }));
    app.use(errorHandler);

    const response = await request(app).get("/api/tools/oauth/cloud-connector/enrollment");

    expect(response.status).toBe(200);
    expect(await db.select().from(googlePendingRevocations)).toHaveLength(rows);
    expect(await liveSecretCount(fixture.company.id)).toBe(rows === 1 ? 1 : 2);
  });

  async function pinOlderRefreshVersion(fixture: Awaited<ReturnType<typeof connectManagedGmail>>) {
    const refreshRef = fixture.grant.credentialSecretRefs.find((ref) => ref.configPath === "oauth.refresh_token")!;
    const [secret] = await db.select({ latestVersion: companySecrets.latestVersion }).from(companySecrets).where(eq(companySecrets.id, refreshRef.secretId));
    await secretService(db).rotate(refreshRef.secretId, { value: "newer-refresh-token-do-not-log" });
    await db.update(connectionGrants).set({
      credentialSecretRefs: fixture.grant.credentialSecretRefs.map((ref) => ref.secretId === refreshRef.secretId ? { ...ref, versionSelector: secret!.latestVersion } : ref),
    }).where(eq(connectionGrants.id, fixture.grant.id));
    return { secretId: refreshRef.secretId, pinned: secret!.latestVersion };
  }

  it("queues the grant's pinned token version when the company is deleted", async () => {
    const fixture = await connectManagedGmail();
    await pinOlderRefreshVersion(fixture);

    await deleteCompany(db, fixture.company.id);
    await drain(fixture.connector, Date.now());

    expect(fixture.connector.revoke).toHaveBeenCalledTimes(1);
    expect(fixture.connector.revoke).toHaveBeenCalledWith(expect.objectContaining({ token: REFRESH_TOKEN }));
  });

  it("judges live use by the version a live grant selects, not the latest version", async () => {
    const fixture = await connectManagedGmail();
    const { secretId, pinned } = await pinOlderRefreshVersion(fixture);
    await queueGoogleRevocationFromSecret(db, {
      companyId: fixture.company.id, connectionId: fixture.connectionId, grantId: fixture.grant.id, subject: fixture.userId,
      profile: "gmail.draft", secretId, version: pinned, reason: "grant_revoked",
    });
    const [held] = await db.select().from(googlePendingRevocations);

    await drain(fixture.connector, held!.nextAttemptAt.getTime());
    expect(fixture.connector.revoke).not.toHaveBeenCalled();
    expect(await db.select().from(googlePendingRevocations)).toEqual([]);

    const [latest] = await db.select({ latestVersion: companySecrets.latestVersion }).from(companySecrets).where(eq(companySecrets.id, secretId));
    await queueGoogleRevocationFromSecret(db, {
      companyId: fixture.company.id, connectionId: fixture.connectionId, grantId: fixture.grant.id, subject: fixture.userId,
      profile: "gmail.draft", secretId, version: latest!.latestVersion, reason: "grant_revoked",
    });
    const [unused] = await db.select().from(googlePendingRevocations);
    await drain(fixture.connector, unused!.nextAttemptAt.getTime());
    expect(fixture.connector.revoke).toHaveBeenCalledWith(expect.objectContaining({ token: "newer-refresh-token-do-not-log" }));
  });

  it("keeps retrying the old token when the user signs in again with a new token during the first call", async () => {
    const fixture = await connectManagedGmail();
    const refreshSecretId = fixture.grant.credentialSecretRefs.find((ref) => ref.configPath === "oauth.refresh_token")!.secretId;
    fixture.connector.revoke.mockImplementationOnce(async () => {
      await secretService(db).rotate(refreshSecretId, { value: "signed-in-again-token-do-not-log" });
      await db.update(connectionGrants).set({ status: "active", revokedAt: null }).where(eq(connectionGrants.id, fixture.grant.id));
      return { outcome: "broker_error" };
    });

    const response = await request(fixture.app).delete(`/api/tool-connections/${fixture.connectionId}/grants/${fixture.grant.id}`);

    expect(response.body.providerAccess).toEqual({ provider: "google", result: "retrying", outcomes: ["broker_error"] });
    const [pending] = await db.select().from(googlePendingRevocations);
    fixture.connector.revoke.mockResolvedValueOnce({ outcome: "other_connections_remain" });
    await drain(fixture.connector, pending!.nextAttemptAt.getTime());
    expect(fixture.connector.revoke).toHaveBeenLastCalledWith(expect.objectContaining({ token: REFRESH_TOKEN }));
    expect(await db.select().from(googlePendingRevocations)).toEqual([]);
  });

  it("moves a pending removal to the removed-instance rule when Cloud removes the instance", async () => {
    const fixture = await connectManagedGmail();
    const refreshSecretId = fixture.grant.credentialSecretRefs.find((ref) => ref.configPath === "oauth.refresh_token")!.secretId;
    const [secret] = await db.select({ latestVersion: companySecrets.latestVersion }).from(companySecrets).where(eq(companySecrets.id, refreshSecretId));
    await queueGoogleRevocationFromSecret(db, {
      companyId: fixture.company.id, connectionId: fixture.connectionId, grantId: fixture.grant.id, subject: fixture.userId,
      profile: "gmail.draft", secretId: refreshSecretId, version: secret!.latestVersion, reason: "grant_revoked",
    });

    await revokeGoogleAccessForRemovedInstance(db, async () => { throw new Error("stopped before the token was dropped"); });

    const [pending] = await db.select().from(googlePendingRevocations);
    expect(pending!.reason).toBe("instance_removed");
    await drain(fixture.connector, pending!.nextAttemptAt.getTime());
    expect(fixture.connector.revoke).toHaveBeenCalledWith(expect.objectContaining({ token: REFRESH_TOKEN }));
  });

  it("keeps one company's pending revocation apart from another company's with the same token", async () => {
    const first = await connectManagedGmail();
    const second = await connectManagedGmail();
    first.connector.revoke.mockResolvedValueOnce({ outcome: "broker_error" });
    second.connector.revoke.mockResolvedValueOnce({ outcome: "revoked" });

    await request(first.app).delete(`/api/tool-connections/${first.connectionId}`);
    await request(second.app).delete(`/api/tool-connections/${second.connectionId}`);

    const rows = await db.select().from(googlePendingRevocations);
    expect(rows.map((row) => row.companyId)).toEqual([first.company.id]);
    expect(rows[0]).toMatchObject({ attempts: 1, lastOutcome: "broker_error" });
  });

  it("treats an older broker refusing a removed instance as retryable", async () => {
    const fixture = await connectManagedGmail();
    fixture.connector.revoke.mockRejectedValue(new PaperclipCloudConnectorError("rejected", "CONNECTOR_REQUEST_FAILED", 403, undefined, "INSTANCE_SUSPENDED"));

    const response = await request(fixture.app).delete(`/api/tool-connections/${fixture.connectionId}`);

    expect(response.body.removal.providerAccess).toEqual({ provider: "google", result: "retrying", outcomes: ["broker_error"] });
    const [pending] = await db.select().from(googlePendingRevocations);
    await drain(fixture.connector, pending!.nextAttemptAt.getTime());
    const [after] = await db.select().from(googlePendingRevocations);
    expect(after).toMatchObject({ attempts: 2, lastOutcome: "broker_error" });
  });

  it("queues every managed Google token when the company is deleted, and revokes it after the company is gone", async () => {
    const fixture = await connectManagedGmail();

    await deleteCompany(db, fixture.company.id);

    expect(await db.select().from(companies).where(eq(companies.id, fixture.company.id))).toEqual([]);
    const [pending] = await db.select().from(googlePendingRevocations);
    expect(pending).toMatchObject({ companyId: fixture.company.id, subject: fixture.userId, profile: "gmail.draft", reason: "company_deleted", attempts: 0 });
    expect(JSON.stringify(pending)).not.toContain(REFRESH_TOKEN);
    expect(fixture.connector.revoke).not.toHaveBeenCalled();

    await drain(fixture.connector, Date.now());
    expect(fixture.connector.revoke).toHaveBeenCalledWith(expect.objectContaining({
      subject: fixture.userId, companyId: fixture.company.id, profile: "gmail.draft", token: REFRESH_TOKEN }));
    expect(await db.select().from(googlePendingRevocations)).toEqual([]);
  });

  it("revokes every managed Google grant through the broker when Cloud removed the instance, then drops the token", async () => {
    const fixture = await connectManagedGmail();
    const secrets = secretService(db);

    expect(await revokeGoogleAccessForRemovedInstance(db, (secretId, expectedVersion) => secrets.remove(secretId, { expectedVersion }))).toBe(1);

    const refreshSecretId = fixture.grant.credentialSecretRefs.find((ref) => ref.configPath === "oauth.refresh_token")!.secretId;
    const [refresh] = await db.select({ id: companySecrets.id }).from(companySecrets).where(eq(companySecrets.id, refreshSecretId));
    expect(refresh).toBeUndefined();
    const [pending] = await db.select().from(googlePendingRevocations);
    expect(pending).toMatchObject({ reason: "instance_removed", connectionId: fixture.connectionId });
    expect(await revokeGoogleAccessForRemovedInstance(db, (secretId, expectedVersion) => secrets.remove(secretId, { expectedVersion }))).toBe(0);

    await drain(fixture.connector, Date.now());
    expect(fixture.connector.revoke).toHaveBeenCalledWith(expect.objectContaining({ token: REFRESH_TOKEN, subject: fixture.userId }));
    expect(await db.select().from(googlePendingRevocations)).toEqual([]);
    expect(await retryAudit(fixture.company.id)).toEqual([{ outcome: "success", reasonCode: "ended" }]);
  });
});
