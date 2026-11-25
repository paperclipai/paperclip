import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import {
  activityLog,
  companies,
  companyMemberships,
  companySecrets,
  connectionGrants,
  createDb,
  googlePendingRevocations,
  toolConnections,
  userSecretDefinitions,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const releaseControl = vi.hoisted(() => ({ fail: false }));
vi.mock("../services/heartbeat/provider-limit-wait.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat/provider-limit-wait.js")>();
  return {
    ...actual,
    releaseProviderLimitWaits: async (...args: Parameters<typeof actual.releaseProviderLimitWaits>) => {
      if (releaseControl.fail) throw new Error("hold release failed");
      return actual.releaseProviderLimitWaits(...args);
    },
  };
});
vi.mock("../services/subscription-refresh.js", () => ({ refreshSubscriptionConnection: vi.fn().mockResolvedValue(undefined) }));

import { logger } from "../middleware/logger.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { toolAccessService } from "../services/tool-access.js";
import {
  ANTIGRAVITY_REVOCATION_MAX_ATTEMPTS,
  ANTIGRAVITY_REVOCATION_PROFILE,
  GOOGLE_OAUTH_REVOKE_URL,
} from "../services/antigravity-google-revocation.js";
import { createGooglePendingRevocation } from "../services/tool-access/connections/google-pending-revocation.js";
import type { PaperclipCloudConnector } from "../services/paperclip-cloud-connector.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const REFRESH_TOKEN = "antigravity-refresh-token-do-not-log";
const credential = (refreshToken = REFRESH_TOKEN) => JSON.stringify({
  client_id: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
  client_secret: "fixture-client-secret",
  refresh_token: refreshToken,
  token_uri: "https://oauth2.googleapis.com/token",
  scopes: ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/aicode"],
});

describeEmbeddedPostgres("revoking a Google sign-in at Google on disconnect", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home = "";

  beforeAll(async () => {
    home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-antigravity-revoke-")));
    vi.stubEnv("PAPERCLIP_HOME", home);
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-antigravity-revoke-");
    db = createDb(tempDb.connectionString, { maxConnections: 4 });
  }, 30_000);

  afterEach(async () => {
    releaseControl.fail = false;
    vi.restoreAllMocks();
    await db.delete(googlePendingRevocations);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
    if (home) await rm(home, { recursive: true, force: true });
  });

  function stubGoogle(respond: () => Promise<Response> | Response) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url) !== GOOGLE_OAUTH_REVOKE_URL) throw new Error(`Unexpected request to ${String(url)}`);
      return respond();
    });
  }

  async function company() {
    const [row] = await db.insert(companies).values({
      name: `Antigravity revoke ${randomUUID()}`,
      issuePrefix: `AR${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning();
    const userId = `antigravity-owner-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId: row!.id, principalType: "user", principalId: userId, status: "active", membershipRole: "owner",
    });
    return { companyId: row!.id, userId };
  }

  async function connectGoogle(input: { companyId: string; userId: string; ownership: "personal" | "shared"; account: string; refreshToken?: string }) {
    const saved = await aiConnectionService(db).save(input.companyId, input.userId, {
      provider: "google", method: "subscription", ownership: input.ownership, name: `Google ${input.account}`,
      loginSessionId: "fixture", agentIds: [], allAgents: true,
    }, credential(input.refreshToken), undefined, undefined, undefined, input.account);
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, saved.grantId));
    return { ...saved, secretId: grant!.credentialSecretRefs[0]!.secretId };
  }

  async function liveSecret(companyId: string, secretId: string) {
    return (await db.select({ id: companySecrets.id }).from(companySecrets)
      .where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.id, secretId), isNull(companySecrets.deletedAt)))).length > 0;
  }

  async function activityActions(companyId: string) {
    return (await db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).map((row) => row.action);
  }

  function retryWorker(revokeAtGoogle: (token: string) => Promise<"revoked" | "provider_revocation_failed">) {
    return (at: number) => createGooglePendingRevocation(db, {
      currentCloudConnector: () => null as unknown as PaperclipCloudConnector,
      revokeAtGoogle,
      now: () => at,
    }).drain(new AbortController().signal);
  }

  it("revokes the stored refresh token at Google and deletes it when a personal account is disconnected", async () => {
    const { companyId, userId } = await company();
    const account = await connectGoogle({ companyId, userId, ownership: "personal", account: "alice@example.test" });
    const google = stubGoogle(() => new Response(null, { status: 200 }));

    const revoked = await toolAccessService(db).revokeConnectionGrant(account.connectionId, account.grantId, { actorType: "user", actorId: userId });

    expect(revoked.providerAccess).toEqual({ provider: "google", result: "ended", outcomes: ["revoked"] });
    expect(google).toHaveBeenCalledTimes(1);
    const [, init] = google.mock.calls[0]!;
    expect(init?.method).toBe("POST");
    expect(new URLSearchParams(String(init?.body)).get("token")).toBe(REFRESH_TOKEN);
    expect(await liveSecret(companyId, account.secretId)).toBe(false);
    const definitions = await db.select().from(userSecretDefinitions)
      .where(and(eq(userSecretDefinitions.companyId, companyId), eq(userSecretDefinitions.key, `ai_${account.grantId.replaceAll("-", "_")}`)));
    expect(definitions).toEqual([]);
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, account.grantId));
    expect(grant).toMatchObject({ status: "revoked", credentialSecretRefs: [] });
    expect(await db.select().from(googlePendingRevocations)).toEqual([]);

    const reconnected = await aiConnectionService(db).save(companyId, userId, {
      provider: "google", method: "subscription", ownership: "personal", name: "Google alice@example.test",
      loginSessionId: "fixture", agentIds: [], allAgents: true, connectionId: account.connectionId,
    }, credential("alice-new-refresh-do-not-log"), undefined, undefined, undefined, "alice@example.test");
    expect(reconnected.grantId).toBe(account.grantId);
    const [restored] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, account.grantId));
    expect(restored?.status).toBe("active");
    expect(await liveSecret(companyId, restored!.credentialSecretRefs[0]!.secretId)).toBe(true);
  });

  it("treats a token Google already revoked as ended", async () => {
    const { companyId, userId } = await company();
    const account = await connectGoogle({ companyId, userId, ownership: "shared", account: "bob@example.test" });
    stubGoogle(() => Response.json({ error: "invalid_token" }, { status: 400 }));

    const revoked = await toolAccessService(db).revokeConnectionGrant(account.connectionId, account.grantId, { actorType: "user", actorId: userId });

    expect(revoked.providerAccess).toEqual({ provider: "google", result: "ended", outcomes: ["revoked"] });
    expect(await liveSecret(companyId, account.secretId)).toBe(false);
  });

  it("does not revoke at Google while another connection in the company still uses the same Google account", async () => {
    const { companyId, userId } = await company();
    const first = await connectGoogle({ companyId, userId, ownership: "shared", account: "carol@example.test", refreshToken: "first-refresh-do-not-log" });
    await connectGoogle({ companyId, userId, ownership: "personal", account: "Carol@Example.test", refreshToken: "second-refresh-do-not-log" });
    const google = stubGoogle(() => new Response(null, { status: 200 }));

    const revoked = await toolAccessService(db).revokeConnectionGrant(first.connectionId, first.grantId, { actorType: "user", actorId: userId });

    expect(revoked.providerAccess).toEqual({ provider: "google", result: "other_connections_remain", outcomes: ["other_connections_remain"] });
    expect(google).not.toHaveBeenCalled();
    expect(await liveSecret(companyId, first.secretId)).toBe(false);
  });

  it("removes the connection when Google cannot be reached, keeps only an encrypted copy, and retries until Google confirms", async () => {
    const { companyId, userId } = await company();
    const account = await connectGoogle({ companyId, userId, ownership: "shared", account: "dana@example.test" });
    stubGoogle(() => { throw new TypeError("network down"); });
    const warn = vi.spyOn(logger, "warn");
    const startedAt = Date.now();

    const removed = await toolAccessService(db).archiveConnection(account.connectionId, companyId, { actorType: "user", actorId: userId });

    expect(removed.removal.providerAccess).toEqual({ provider: "google", result: "retrying", outcomes: ["provider_revocation_failed"] });
    expect(removed.connection.status).toBe("archived");
    expect(await liveSecret(companyId, account.secretId)).toBe(false);
    const [pending] = await db.select().from(googlePendingRevocations);
    expect(pending).toMatchObject({ companyId, connectionId: account.connectionId, grantId: account.grantId,
      profile: ANTIGRAVITY_REVOCATION_PROFILE, reason: "connection_removed", attempts: 1, lastOutcome: "provider_revocation_failed" });
    expect(JSON.stringify(pending)).not.toContain(REFRESH_TOKEN);
    expect(JSON.stringify(pending)).not.toContain("dana@example.test");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(REFRESH_TOKEN);

    const revokeAtGoogle = vi.fn(async (_token: string) => "revoked" as const);
    await retryWorker(revokeAtGoogle)(pending!.nextAttemptAt.getTime());

    expect(revokeAtGoogle).toHaveBeenCalledExactlyOnceWith(REFRESH_TOKEN, expect.any(Number));
    expect(await db.select().from(googlePendingRevocations)).toEqual([]);
    expect(await activityActions(companyId)).toContain("tool_connection.google_access_ended");
    expect(pending!.nextAttemptAt.getTime() - startedAt).toBeGreaterThanOrEqual(50_000);
  });

  it("stops retrying after a bounded number of attempts and records that access was not ended", async () => {
    const { companyId, userId } = await company();
    const account = await connectGoogle({ companyId, userId, ownership: "personal", account: "erin@example.test" });
    stubGoogle(() => new Response(null, { status: 503 }));

    const revoked = await toolAccessService(db).revokeConnectionGrant(account.connectionId, account.grantId, { actorType: "user", actorId: userId });
    expect(revoked.providerAccess?.result).toBe("retrying");
    expect(await liveSecret(companyId, account.secretId)).toBe(false);

    const revokeAtGoogle = vi.fn(async (_token: string) => "provider_revocation_failed" as const);
    for (let pass = 0; pass < ANTIGRAVITY_REVOCATION_MAX_ATTEMPTS + 3; pass += 1) {
      const [due] = await db.select().from(googlePendingRevocations);
      if (!due) break;
      await retryWorker(revokeAtGoogle)(due.nextAttemptAt.getTime());
    }

    expect(revokeAtGoogle).toHaveBeenCalledTimes(ANTIGRAVITY_REVOCATION_MAX_ATTEMPTS - 1);
    expect(await db.select().from(googlePendingRevocations)).toEqual([]);
    expect(await activityActions(companyId)).toContain("tool_connection.google_access_not_ended");
  });

  it("does not retry once the same Google account is connected again", async () => {
    const { companyId, userId } = await company();
    const account = await connectGoogle({ companyId, userId, ownership: "shared", account: "faye@example.test" });
    stubGoogle(() => { throw new TypeError("network down"); });
    await toolAccessService(db).revokeConnectionGrant(account.connectionId, account.grantId, { actorType: "user", actorId: userId });
    const [pending] = await db.select().from(googlePendingRevocations);
    expect(pending).toBeDefined();

    await connectGoogle({ companyId, userId, ownership: "personal", account: "faye@example.test", refreshToken: "faye-new-refresh-do-not-log" });
    const revokeAtGoogle = vi.fn(async (_token: string) => "revoked" as const);
    await retryWorker(revokeAtGoogle)(pending!.nextAttemptAt.getTime());

    expect(revokeAtGoogle).not.toHaveBeenCalled();
    expect(await db.select().from(googlePendingRevocations)).toEqual([]);
  });

  it("leaves every grant active and the token stored when releasing held work fails during removal", async () => {
    const { companyId, userId } = await company();
    const account = await connectGoogle({ companyId, userId, ownership: "shared", account: "gail@example.test" });
    const google = stubGoogle(() => new Response(null, { status: 200 }));
    releaseControl.fail = true;

    await expect(toolAccessService(db).archiveConnection(account.connectionId, companyId, { actorType: "user", actorId: userId }))
      .rejects.toThrow("hold release failed");

    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, account.grantId));
    expect(grant?.status).toBe("active");
    expect(google).not.toHaveBeenCalled();
    expect(await liveSecret(companyId, account.secretId)).toBe(true);

    releaseControl.fail = false;
    const removed = await toolAccessService(db).archiveConnection(account.connectionId, companyId, { actorType: "user", actorId: userId });
    expect(removed.removal.providerAccess?.result).toBe("ended");
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, account.connectionId));
    expect(connection?.status).toBe("archived");
    expect(await liveSecret(companyId, account.secretId)).toBe(false);
  });
});
