import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  authAccounts,
  authUsers,
  authVerifications,
  companies,
  companyMemberships,
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import {
  authorizePaperclipOidcLinkIntent,
  bindPaperclipOidcAccount,
  bindPaperclipOidcAccountForCallback,
  consumePaperclipOidcLinkIntent,
  consumePaperclipOidcLinkIntentForCallback,
  createPaperclipOidcLinkIntent,
  paperclipOidc,
  paperclipOidcLinkBodySchema,
  paperclipOidcSignInBodySchema,
  paperclipOidcRedirectPath,
  paperclipOidcStateCookieName,
  paperclipOidcStateCookieOptions,
  readPaperclipOidcConfig,
  sealOidcState,
  unsealOidcState,
  validatePaperclipOidcClaims,
  validatePaperclipOidcLinkEmailForCallback,
  verifyPaperclipOidcLinkPassword,
} from "../auth/paperclip-oidc.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("Paperclip ID OIDC", () => {
  it("is disabled unless every required credential is configured", () => {
    expect(readPaperclipOidcConfig({})).toBeNull();
    expect(readPaperclipOidcConfig({ PAPERCLIP_OIDC_ISSUER: "https://id.example", PAPERCLIP_OIDC_CLIENT_ID: "client" })).toBeNull();
    expect(readPaperclipOidcConfig({ PAPERCLIP_OIDC_ISSUER: "not a url", PAPERCLIP_OIDC_CLIENT_ID: "client", PAPERCLIP_OIDC_CLIENT_SECRET: "secret" })).toBeNull();
  });

  it("normalizes scopes and always requests openid", () => {
    expect(readPaperclipOidcConfig({ PAPERCLIP_OIDC_ISSUER: "https://id.example/", PAPERCLIP_OIDC_CLIENT_ID: "client", PAPERCLIP_OIDC_CLIENT_SECRET: "secret", PAPERCLIP_OIDC_SCOPES: "email,profile" }))
      .toEqual({ issuer: "https://id.example", clientId: "client", clientSecret: "secret", scopes: ["openid", "email", "profile"] });
  });

  it("restricts redirects and isolates concurrent state cookies", () => {
    expect(paperclipOidcRedirectPath("/projects?tab=all", "/")).toBe("/projects?tab=all");
    expect(paperclipOidcRedirectPath("https://evil.example", "/")).toBe("/");
    expect(paperclipOidcRedirectPath("//evil.example", "/auth")).toBe("/auth");
    expect(paperclipOidcRedirectPath("/\\evil.example", "/auth")).toBe("/auth");
    expect(paperclipOidcStateCookieName("state-a")).not.toBe(paperclipOidcStateCookieName("state-b"));
  });

  it("rejects tampered and expired callback state", () => {
    const state = { state: "state", nonce: "nonce", codeVerifier: "verifier", callbackURL: "/", errorCallbackURL: "/auth", expiresAt: 2_000 };
    const sealed = sealOidcState(state, "secret");
    expect(unsealOidcState(sealed, "secret", 1_000)).toEqual(state);
    expect(unsealOidcState(`${sealed}x`, "secret", 1_000)).toBeNull();
    expect(unsealOidcState(sealed, "secret", 3_000)).toBeNull();
  });

  it("requires an explicitly verified email claim", () => {
    expect(validatePaperclipOidcClaims({ sub: "subject", email: "USER@example.com", email_verified: true, name: "User" }))
      .toEqual({ subject: "subject", email: "user@example.com", name: "User" });
    expect(() => validatePaperclipOidcClaims({ sub: "subject", email: "user@example.com", email_verified: false })).toThrow();
    expect(() => validatePaperclipOidcClaims({ sub: "subject", email: "user@example.com", email_verified: "true" })).toThrow();
  });

  it("requires the dedicated linking endpoint and a password", async () => {
    expect(() => paperclipOidcSignInBodySchema.parse({ callbackURL: "/", link: true })).toThrow();
    expect(() => paperclipOidcLinkBodySchema.parse({ callbackURL: "/" })).toThrow();
    expect(paperclipOidcLinkBodySchema.parse({ callbackURL: "/", password: "correct horse" }))
      .toEqual({ callbackURL: "/", password: "correct horse" });

    const signInEndpoint = paperclipOidc({
      issuer: "https://id.example.test",
      clientId: "client",
      clientSecret: "secret",
      scopes: ["openid"],
    }, "state-secret", {} as Parameters<typeof paperclipOidc>[2]).endpoints?.paperclipOidcSignIn;
    await expect(signInEndpoint?.({
      body: { callbackURL: "/", link: true },
      context: {},
    } as never)).rejects.toThrow("Unrecognized key(s) in object: 'link'");
  });

  it("rejects OIDC-only accounts and wrong passwords while accepting the local credential", async () => {
    const verify = vi.fn(async ({ hash, password }: { hash: string; password: string }) => hash === "stored" && password === "correct");

    await expect(verifyPaperclipOidcLinkPassword([{ providerId: "paperclip-id", password: null }], "correct", verify))
      .resolves.toBe(false);
    await expect(verifyPaperclipOidcLinkPassword([{ providerId: "credential", password: "stored" }], "wrong", verify))
      .resolves.toBe(false);
    await expect(verifyPaperclipOidcLinkPassword([{ providerId: "credential", password: "stored" }], "correct", verify))
      .resolves.toBe(true);
  });

  it("marks the OIDC state cookie secure only for HTTPS external URLs", () => {
    expect(paperclipOidcStateCookieOptions("https://paperclip.example.test").secure).toBe(true);
    expect(paperclipOidcStateCookieOptions("http://paperclip.local.test:3100").secure).toBe(false);
  });
});

describeEmbeddedPostgres("Paperclip ID OIDC persistence", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-oidc-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    await db.delete(activityLog);
    await db.delete(companyMemberships);
    await db.delete(authAccounts);
    await db.delete(authVerifications);
    await db.delete(authUsers);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("binds link intents to one session, expires them, and consumes them once", async () => {
    const now = new Date("2026-07-28T12:00:00.000Z");
    const token = await createPaperclipOidcLinkIntent(db, { userId: "user-1", sessionId: "session-1" }, now);

    await expect(consumePaperclipOidcLinkIntent(db, token, { userId: "user-1", sessionId: "session-2" }, now))
      .resolves.toBe(false);
    await expect(consumePaperclipOidcLinkIntent(db, token, { userId: "user-1", sessionId: "session-1" }, now))
      .resolves.toBe(true);
    await expect(consumePaperclipOidcLinkIntent(db, token, { userId: "user-1", sessionId: "session-1" }, now))
      .resolves.toBe(false);

    const expiredToken = await createPaperclipOidcLinkIntent(db, { userId: "user-1", sessionId: "session-1" }, now);
    await expect(consumePaperclipOidcLinkIntent(
      db,
      expiredToken,
      { userId: "user-1", sessionId: "session-1" },
      new Date(now.getTime() + 10 * 60 * 1000),
    )).resolves.toBe(false);
  });

  it("mediates link-intent creation with local-password reauthentication and secret-free audit events", async () => {
    const now = new Date("2026-07-28T12:00:00.000Z");
    const userId = randomUUID();
    const companyId = randomUUID();
    await db.insert(authUsers).values({
      id: userId,
      name: "Link User",
      email: "link@example.test",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companies).values({ id: companyId, name: "OIDC Audit Company", issuePrefix: "OID" });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
    });
    const verify = vi.fn(async ({ hash, password }: { hash: string; password: string }) => (
      hash === "stored-password-hash" && password === "correct-password-secret"
    ));

    await expect(authorizePaperclipOidcLinkIntent(db, {
      userId,
      sessionId: "session-1",
      accounts: [{ providerId: "paperclip-id:https://id.example.test", password: null }],
      password: "correct-password-secret",
      verify,
    }, now)).resolves.toEqual({ ok: false, reason: "local_password_unavailable" });
    await expect(authorizePaperclipOidcLinkIntent(db, {
      userId,
      sessionId: "session-1",
      accounts: [{ providerId: "credential", password: "stored-password-hash" }],
      password: "wrong-password-secret",
      verify,
    }, now)).resolves.toEqual({ ok: false, reason: "wrong_password" });
    expect(await db.select().from(authVerifications)).toHaveLength(0);

    const authorized = await authorizePaperclipOidcLinkIntent(db, {
      userId,
      sessionId: "session-1",
      accounts: [{ providerId: "credential", password: "stored-password-hash" }],
      password: "correct-password-secret",
      verify,
    }, now);
    expect(authorized.ok).toBe(true);
    if (!authorized.ok) throw new Error("Expected link intent authorization");

    const [intent] = await db.select().from(authVerifications);
    expect(intent).toMatchObject({
      identifier: "paperclip-oidc-link:",
      value: JSON.stringify({ userId, sessionId: "session-1" }),
      expiresAt: new Date("2026-07-28T12:10:00.000Z"),
    });
    expect(intent?.id).not.toContain(authorized.linkIntent);

    const events = await db.select().from(activityLog);
    expect(events.map(({ action, details }) => ({ action, details }))).toEqual([
      { action: "auth.oidc_link_intent_denied", details: { reason: "local_password_unavailable" } },
      { action: "auth.oidc_link_intent_denied", details: { reason: "wrong_password" } },
      { action: "auth.oidc_link_intent_created", details: {} },
    ]);
    expect(JSON.stringify(events)).not.toContain("correct-password-secret");
    expect(JSON.stringify(events)).not.toContain("wrong-password-secret");
    expect(JSON.stringify(events)).not.toContain("stored-password-hash");
    expect(JSON.stringify(events)).not.toContain(authorized.linkIntent);
  });

  it("fails replay, expiry, and cross-session callback intent use closed and audits each denial", async () => {
    const now = new Date("2026-07-28T12:00:00.000Z");
    const userId = randomUUID();
    const companyId = randomUUID();
    const providerId = "paperclip-id:https://id.example.test";
    await db.insert(authUsers).values({ id: userId, name: "Callback User", email: "callback@example.test", emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(companies).values({ id: companyId, name: "OIDC Callback Company", issuePrefix: "OIC" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active" });

    const token = await createPaperclipOidcLinkIntent(db, { userId, sessionId: "session-1" }, now);
    await expect(consumePaperclipOidcLinkIntentForCallback(db, token, { userId, sessionId: "session-2" }, providerId, now)).resolves.toBe(false);
    await expect(consumePaperclipOidcLinkIntentForCallback(db, token, { userId, sessionId: "session-1" }, providerId, now)).resolves.toBe(true);
    await expect(consumePaperclipOidcLinkIntentForCallback(db, token, { userId, sessionId: "session-1" }, providerId, now)).resolves.toBe(false);

    const expired = await createPaperclipOidcLinkIntent(db, { userId, sessionId: "session-1" }, now);
    await expect(consumePaperclipOidcLinkIntentForCallback(
      db,
      expired,
      { userId, sessionId: "session-1" },
      providerId,
      new Date("2026-07-28T12:10:00.000Z"),
    )).resolves.toBe(false);

    const deniedEvents = await db.select().from(activityLog);
    expect(deniedEvents.map(({ action, details }) => ({ action, details }))).toEqual([
      { action: "auth.oidc_account_link_denied", details: { reason: "cross_session_intent", providerId } },
      { action: "auth.oidc_account_link_denied", details: { reason: "replayed_or_stale_intent", providerId } },
      { action: "auth.oidc_account_link_denied", details: { reason: "expired_intent", providerId } },
    ]);
    expect(JSON.stringify(deniedEvents)).not.toContain(token);
    expect(JSON.stringify(deniedEvents)).not.toContain(expired);
  });

  it("denies and audits callback email mismatch without exposing identity claims", async () => {
    const now = new Date("2026-07-28T12:00:00.000Z");
    const userId = randomUUID();
    const companyId = randomUUID();
    const providerId = "paperclip-id:https://id.example.test";
    await db.insert(authUsers).values({ id: userId, name: "Email User", email: "local@example.test", emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(companies).values({ id: companyId, name: "OIDC Email Company", issuePrefix: "OIE" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active" });

    await expect(validatePaperclipOidcLinkEmailForCallback(
      db,
      { id: userId, email: "local@example.test" },
      "remote-secret@example.test",
      providerId,
    )).resolves.toBe(false);

    const [event] = await db.select().from(activityLog);
    expect(event).toMatchObject({
      action: "auth.oidc_account_link_denied",
      details: { reason: "email_mismatch", providerId },
    });
    expect(JSON.stringify(event)).not.toContain("local@example.test");
    expect(JSON.stringify(event)).not.toContain("remote-secret@example.test");
  });

  it("allows only one user to win concurrent issuer-subject binding", async () => {
    const timestamp = new Date("2026-07-28T12:00:00.000Z");
    const userIds = [randomUUID(), randomUUID()];
    await db.insert(authUsers).values(userIds.map((id, index) => ({
      id,
      name: `User ${index + 1}`,
      email: `user-${index + 1}@example.test`,
      emailVerified: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    })));

    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "OIDC Race Company", issuePrefix: "OIR" });
    await db.insert(companyMemberships).values(userIds.map((userId) => ({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
    })));
    const createSession = vi.fn(async (userId: string) => ({ userId }));
    const results = await Promise.all(userIds.map(async (userId) => {
      const bound = await bindPaperclipOidcAccountForCallback(db, {
      userId,
      providerId: "paperclip-id:https://id.example.test",
      accountId: "shared-subject",
      }, timestamp);
      if (bound) await createSession(userId);
      return bound;
    }));

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((result) => !result)).toHaveLength(1);
    const rows = await db.select({ userId: authAccounts.userId }).from(authAccounts);
    expect(rows).toHaveLength(1);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledWith(rows[0]?.userId);
    const events = await db.select().from(activityLog);
    expect(events.map(({ action, details }) => ({ action, details }))).toEqual(expect.arrayContaining([
      { action: "auth.oidc_account_linked", details: { providerId: "paperclip-id:https://id.example.test" } },
      { action: "auth.oidc_account_link_denied", details: { reason: "issuer_subject_conflict", providerId: "paperclip-id:https://id.example.test" } },
    ]));
    const losingUserId = userIds.find((userId) => userId !== rows[0]?.userId);
    expect(losingUserId).toBeDefined();
    await expect(bindPaperclipOidcAccount(db, {
      userId: losingUserId!,
      providerId: "paperclip-id:https://id.example.test",
      accountId: "shared-subject",
    }, timestamp)).resolves.toBe(false);
  });

  it("deduplicates same-user legacy bindings and rejects cross-user legacy bindings", async () => {
    const timestamp = new Date("2026-07-28T12:00:00.000Z");
    const userIds = [randomUUID(), randomUUID()];
    await db.insert(authUsers).values(userIds.map((id, index) => ({
      id,
      name: `Migration User ${index + 1}`,
      email: `migration-user-${index + 1}@example.test`,
      emailVerified: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    })));
    const migration = await readFile(
      new URL("../../../packages/db/src/migrations/0196_oidc_account_binding_unique.sql", import.meta.url),
      "utf8",
    );
    const statements = migration.split("--> statement-breakpoint").map((statement) => statement.trim()).filter(Boolean);

    await db.execute(sql.raw('DROP INDEX "account_provider_account_unique"'));
    await db.insert(authAccounts).values(["legacy-a", "legacy-b"].map((id) => ({
      id,
      userId: userIds[0]!,
      providerId: "paperclip-id:https://legacy.example.test",
      accountId: "legacy-subject",
      createdAt: timestamp,
      updatedAt: timestamp,
    })));
    for (const statement of statements) await db.execute(sql.raw(statement));
    expect(await db.select().from(authAccounts)).toHaveLength(1);

    await db.execute(sql.raw('DROP INDEX "account_provider_account_unique"'));
    await db.insert(authAccounts).values({
      id: "legacy-cross-user",
      userId: userIds[1]!,
      providerId: "paperclip-id:https://legacy.example.test",
      accountId: "legacy-subject",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await expect(db.execute(sql.raw(statements[0]!))).rejects.toThrow("linked to multiple users");
  });
});
