import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  activityLog,
  companies,
  companyMemberships,
  companySecrets,
  connectionGrants,
  createDb,
  toolConnections,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const control = vi.hoisted(() => ({ failRelease: false }));
vi.mock("../services/heartbeat/provider-limit-wait.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat/provider-limit-wait.js")>();
  return {
    ...actual,
    releaseProviderLimitWaits: async (...args: Parameters<typeof actual.releaseProviderLimitWaits>) => {
      if (control.failRelease) throw new Error("hold release failed");
      return actual.releaseProviderLimitWaits(...args);
    },
  };
});
vi.mock("../services/subscription-refresh.js", () => ({ refreshSubscriptionConnection: vi.fn().mockResolvedValue(undefined) }));

import { aiConnectionService } from "../services/ai-connections.js";
import { toolAccessService } from "../services/tool-access.js";
import { secretService } from "../services/secrets.js";
import { createAntigravitySignInRemoval } from "../services/antigravity-access-removal.js";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { errorHandler } from "../middleware/index.js";

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
const STILL_VALID = { provider: "google", savedSignIn: "deleted", providerSignIn: "still_valid" };

describeEmbeddedPostgres("deleting a saved Google Antigravity sign-in on disconnect", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home = "";

  beforeAll(async () => {
    home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-antigravity-disconnect-")));
    vi.stubEnv("PAPERCLIP_HOME", home);
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-antigravity-disconnect-");
    db = createDb(tempDb.connectionString, { maxConnections: 4 });
  }, 30_000);

  afterEach(async () => {
    control.failRelease = false;
    vi.restoreAllMocks();
    await allowDeletion();
  });

  async function blockDeletion(secretId: string) {
    await db.execute(sql.raw(`create or replace function test_block_secret_delete() returns trigger language plpgsql as $$
      begin
        if old.id = '${secretId}'::uuid and new.deleted_at is not null then raise exception 'vault unavailable'; end if;
        return new;
      end $$`));
    await db.execute(sql.raw("drop trigger if exists test_block_secret_delete on company_secrets"));
    await db.execute(sql.raw("create trigger test_block_secret_delete before update on company_secrets for each row execute function test_block_secret_delete()"));
  }

  async function allowDeletion() {
    await db?.execute(sql.raw("drop trigger if exists test_block_secret_delete on company_secrets"));
  }

  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
    if (home) await rm(home, { recursive: true, force: true });
  });

  function noNetwork() {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      throw new Error(`Unexpected request to ${String(url)}`);
    });
  }

  async function company() {
    const [row] = await db.insert(companies).values({
      name: `Antigravity disconnect ${randomUUID()}`,
      issuePrefix: `AD${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning();
    const userId = `antigravity-owner-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId: row!.id, principalType: "user", principalId: userId, status: "active", membershipRole: "owner",
    });
    return { companyId: row!.id, userId };
  }

  async function connectGoogle(input: { companyId: string; userId: string; ownership: "personal" | "shared"; account: string; refreshToken?: string; connectionId?: string }) {
    const saved = await aiConnectionService(db).save(input.companyId, input.userId, {
      provider: "google", method: "subscription", ownership: input.ownership, name: `Google ${input.account}`,
      loginSessionId: "fixture", agentIds: [], allAgents: true, ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    }, credential(input.refreshToken), undefined, undefined, undefined, input.account);
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, saved.grantId));
    return { ...saved, secretId: grant!.credentialSecretRefs[0]!.secretId };
  }

  async function liveSecret(companyId: string, secretId: string) {
    return (await db.select({ id: companySecrets.id }).from(companySecrets)
      .where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.id, secretId), isNull(companySecrets.deletedAt)))).length > 0;
  }

  async function grantRow(grantId: string) {
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grantId));
    return grant!;
  }

  function app(companyId: string, userId: string) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      req.actor = {
        type: "board", userId, sessionId: `session-${randomUUID()}`, userName: "Owner", userEmail: null,
        isInstanceAdmin: false, source: "session", companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      };
      next();
    });
    server.use("/api", toolAccessRoutes(db, {}));
    server.use(errorHandler);
    return server;
  }

  it("deletes the saved sign-in without calling Google, records it in plain words, and lets the owner reconnect", async () => {
    const { companyId, userId } = await company();
    const account = await connectGoogle({ companyId, userId, ownership: "personal", account: "alice@example.test" });
    const network = noNetwork();

    const response = await request(app(companyId, userId)).delete(`/api/tool-connections/${account.connectionId}/grants/${account.grantId}`);

    expect(response.status).toBe(200);
    expect(response.body.signInRemoval).toEqual(STILL_VALID);
    expect(network).not.toHaveBeenCalled();
    expect(await liveSecret(companyId, account.secretId)).toBe(false);
    expect(await grantRow(account.grantId)).toMatchObject({ status: "revoked", credentialSecretRefs: [] });
    const [entry] = await db.select().from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "tool_connection.grant_revoked")));
    expect(entry?.details).toMatchObject({ signInRemoval: STILL_VALID });
    expect(JSON.stringify(entry?.details)).not.toContain(REFRESH_TOKEN);

    const reconnected = await connectGoogle({ companyId, userId, ownership: "personal", account: "alice@example.test",
      refreshToken: "alice-new-refresh-do-not-log", connectionId: account.connectionId });
    expect(reconnected.grantId).toBe(account.grantId);
    expect((await grantRow(account.grantId)).status).toBe("active");
    expect(await liveSecret(companyId, reconnected.secretId)).toBe(true);
  });

  it("deletes the saved sign-in when the whole connection is removed", async () => {
    const { companyId, userId } = await company();
    const account = await connectGoogle({ companyId, userId, ownership: "shared", account: "bob@example.test" });
    const network = noNetwork();

    const removed = await toolAccessService(db).archiveConnection(account.connectionId, companyId, { actorType: "user", actorId: userId });

    expect(removed.removal.signInRemoval).toEqual(STILL_VALID);
    expect(removed.connection.status).toBe("archived");
    expect(network).not.toHaveBeenCalled();
    expect(await liveSecret(companyId, account.secretId)).toBe(false);
  });

  it("keeps a saved sign-in that another grant still references", async () => {
    const { companyId, userId } = await company();
    const account = await connectGoogle({ companyId, userId, ownership: "shared", account: "carol@example.test" });
    const other = await connectGoogle({ companyId, userId, ownership: "shared", account: "carol-two@example.test" });
    const ref = { secretId: account.secretId, configPath: "ai.credential", required: true, versionSelector: "latest" as const };
    await db.update(connectionGrants).set({ credentialSecretRefs: [ref] }).where(eq(connectionGrants.id, other.grantId));

    const revoked = await toolAccessService(db).revokeConnectionGrant(account.connectionId, account.grantId, { actorType: "user", actorId: userId });

    expect(revoked.signInRemoval).toEqual({ ...STILL_VALID, savedSignIn: "kept_shared" });
    expect(await liveSecret(companyId, account.secretId)).toBe(true);
    expect((await grantRow(other.grantId)).credentialSecretRefs).toEqual([ref]);
    expect((await grantRow(account.grantId)).credentialSecretRefs).toEqual([]);
  });

  it("reports a failed delete, keeps a retryable reference, and deletes on the next disconnect", async () => {
    const { companyId, userId } = await company();
    const account = await connectGoogle({ companyId, userId, ownership: "shared", account: "dana@example.test" });
    await blockDeletion(account.secretId);

    const failed = await toolAccessService(db).revokeConnectionGrant(account.connectionId, account.grantId, { actorType: "user", actorId: userId });

    expect(failed.signInRemoval).toEqual({ ...STILL_VALID, savedSignIn: "not_deleted" });
    expect(await liveSecret(companyId, account.secretId)).toBe(true);
    expect((await grantRow(account.grantId)).credentialSecretRefs.map((entry) => entry.secretId)).toEqual([account.secretId]);

    await allowDeletion();
    const retried = await toolAccessService(db).revokeConnectionGrant(account.connectionId, account.grantId, { actorType: "user", actorId: userId });
    expect(retried.signInRemoval).toEqual(STILL_VALID);
    expect(await liveSecret(companyId, account.secretId)).toBe(false);
  });

  it("keeps the reference after a failed delete during connection removal so removing it again finishes", async () => {
    const { companyId, userId } = await company();
    const account = await connectGoogle({ companyId, userId, ownership: "shared", account: "erin@example.test" });
    await blockDeletion(account.secretId);

    const failed = await toolAccessService(db).archiveConnection(account.connectionId, companyId, { actorType: "user", actorId: userId });

    expect(failed.removal.signInRemoval?.savedSignIn).toBe("not_deleted");
    expect(await liveSecret(companyId, account.secretId)).toBe(true);
    expect((await grantRow(account.grantId)).credentialSecretRefs.map((entry) => entry.secretId)).toEqual([account.secretId]);

    await allowDeletion();
    const retried = await toolAccessService(db).archiveConnection(account.connectionId, companyId, { actorType: "user", actorId: userId });
    expect(retried.removal.signInRemoval).toEqual(STILL_VALID);
    expect(await liveSecret(companyId, account.secretId)).toBe(false);
  });

  it("never deletes a reconnect that saved a new sign-in while the disconnect was finishing", async () => {
    const { companyId, userId } = await company();
    const account = await connectGoogle({ companyId, userId, ownership: "shared", account: "faye@example.test" });
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, account.connectionId));
    const vault = secretService(db);
    const removal = createAntigravitySignInRemoval(db, {
      secrets: {
        remove: async (...args: Parameters<typeof vault.remove>) => {
          await connectGoogle({ companyId, userId, ownership: "shared", account: "faye@example.test",
            refreshToken: "faye-new-refresh-do-not-log", connectionId: account.connectionId });
          return vault.remove(...args);
        },
      },
    });
    const prepared = await removal.prepare(connection!, [await grantRow(account.grantId)]);
    await db.update(connectionGrants).set({ status: "revoked", revokedAt: new Date(), updatedAt: new Date(Date.now() - 1_000) })
      .where(eq(connectionGrants.id, account.grantId));

    const result = await prepared!.send();

    expect(result).toBeNull();
    const grant = await grantRow(account.grantId);
    expect(grant.status).toBe("active");
    expect(grant.credentialSecretRefs.map((entry) => entry.secretId)).toEqual([account.secretId]);
    expect(await liveSecret(companyId, account.secretId)).toBe(true);
    expect(await vault.resolveSecretValue(companyId, account.secretId, "latest")).toBe(credential("faye-new-refresh-do-not-log"));
  });

  it("keeps the reference of a reconnect that lands while the connection is being removed", async () => {
    const { companyId, userId } = await company();
    const account = await connectGoogle({ companyId, userId, ownership: "shared", account: "hana@example.test" });
    const replacement = await secretService(db).create(companyId, { name: `replacement-${randomUUID()}`, provider: "local_encrypted", value: credential("hana-new-refresh-do-not-log") }, { userId });
    const ref = { secretId: replacement.id, configPath: "ai.credential", required: true, versionSelector: "latest" };
    await db.execute(sql.raw(`create or replace function test_reconnect_on_delete() returns trigger language plpgsql as $$
      begin
        if old.id = '${account.secretId}'::uuid then
          update connection_grants set status = 'active', revoked_at = null, credential_secret_refs = '${JSON.stringify([ref])}'::jsonb
            where id = '${account.grantId}'::uuid;
        end if;
        return old;
      end $$`));
    await db.execute(sql.raw("create trigger test_reconnect_on_delete after delete on company_secrets for each row execute function test_reconnect_on_delete()"));
    try {
      await toolAccessService(db).archiveConnection(account.connectionId, companyId, { actorType: "user", actorId: userId });
    } finally {
      await db.execute(sql.raw("drop trigger if exists test_reconnect_on_delete on company_secrets"));
    }

    const grant = await grantRow(account.grantId);
    expect(grant.status).toBe("active");
    expect(grant.credentialSecretRefs).toEqual([ref]);
    expect(await liveSecret(companyId, account.secretId)).toBe(false);
  });

  it("leaves every grant active and the sign-in saved when releasing held work fails during removal", async () => {
    const { companyId, userId } = await company();
    const account = await connectGoogle({ companyId, userId, ownership: "shared", account: "gail@example.test" });
    control.failRelease = true;

    await expect(toolAccessService(db).archiveConnection(account.connectionId, companyId, { actorType: "user", actorId: userId }))
      .rejects.toThrow("hold release failed");

    expect((await grantRow(account.grantId)).status).toBe("active");
    expect(await liveSecret(companyId, account.secretId)).toBe(true);

    control.failRelease = false;
    const removed = await toolAccessService(db).archiveConnection(account.connectionId, companyId, { actorType: "user", actorId: userId });
    expect(removed.removal.signInRemoval).toEqual(STILL_VALID);
    expect(await liveSecret(companyId, account.secretId)).toBe(false);
  });
});
