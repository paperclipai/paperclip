import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, authAccounts, authUsers, authVerifications, companies, companyMemberships, createDb, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";

const mocks = vi.hoisted(() => ({ grant: vi.fn(), discovery: vi.fn(async () => ({})), session: vi.fn(), cookie: vi.fn() }));
vi.mock("openid-client", async (original) => ({ ...await original<typeof import("openid-client")>(), authorizationCodeGrant: mocks.grant, discovery: mocks.discovery }));
vi.mock("better-auth/api", async (original) => ({ ...await original<typeof import("better-auth/api")>(), getSessionFromCtx: mocks.session }));
vi.mock("better-auth/cookies", async (original) => ({ ...await original<typeof import("better-auth/cookies")>(), setSessionCookie: mocks.cookie }));

import { createPaperclipOidcLinkIntent, paperclipOidc, paperclipOidcStateCookieName, sealOidcState } from "../auth/paperclip-oidc.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
const config = { issuer: "https://id.example.test", clientId: "client", clientSecret: "secret", scopes: ["openid"] };
const secret = "state-secret";

function location(error: unknown) {
  return error && typeof error === "object" && "headers" in error && error.headers instanceof Headers ? error.headers.get("location") : null;
}

async function callback(db: Parameters<typeof paperclipOidc>[2], options: {
  adapter: Record<string, unknown>;
  claims?: Record<string, unknown>;
  activeSession?: unknown;
  linkIntent?: string;
}) {
  const state = randomUUID();
  const sealed = sealOidcState({ state, nonce: "nonce", codeVerifier: "verifier", callbackURL: "/", errorCallbackURL: "/auth", linkIntent: options.linkIntent, expiresAt: Date.now() + 60_000 }, secret);
  mocks.grant.mockResolvedValue({ claims: () => options.claims ?? { sub: "subject", email: "user@example.test", email_verified: true }, access_token: "access-secret", refresh_token: "refresh-secret", id_token: "id-secret", scope: "openid email" });
  mocks.session.mockResolvedValue(options.activeSession ?? null);
  const endpoint = paperclipOidc(config, secret, db).endpoints?.paperclipOidcCallback;
  if (!endpoint) throw new Error("missing callback endpoint");
  try {
    await endpoint({
      query: { code: "code", state },
      request: new Request(`http://localhost:3100/api/auth/oauth2/callback/paperclip-id?code=code&state=${state}`),
      headers: new Headers({ cookie: `${paperclipOidcStateCookieName(state)}=${sealed}` }),
      context: { baseURL: "http://localhost:3100/api/auth", internalAdapter: options.adapter },
    } as never);
    return null;
  } catch (error) {
    return location(error);
  }
}

describeDb("Paperclip ID OIDC callback endpoint", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-oidc-callback-");
    db = createDb(database.connectionString);
  }, 120_000);
  afterAll(async () => database?.cleanup());
  beforeEach(async () => {
    vi.clearAllMocks();
    await db.delete(activityLog);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(authAccounts);
    await db.delete(authVerifications);
    await db.delete(authUsers);
  });

  it("rejects cross-session and replayed intents before issuing sessions", async () => {
    const now = new Date();
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "User", email: "user@example.test", emailVerified: true, createdAt: now, updatedAt: now });
    const token = await createPaperclipOidcLinkIntent(db, { userId, sessionId: "session-1" }, now);
    const createSession = vi.fn(async () => ({ id: "new-session" }));
    const adapter = { findAccountByProviderId: vi.fn(async () => null), findUserByEmail: vi.fn(async () => null), createSession };
    expect(await callback(db, { adapter, linkIntent: token, activeSession: { user: { id: userId, email: "user@example.test" }, session: { id: "session-2" } } })).toBe("/auth?oidcError=link_session_expired");
    expect(await callback(db, { adapter, linkIntent: token, activeSession: { user: { id: userId, email: "user@example.test" }, session: { id: "session-1" } } })).toBe("/");
    expect(await callback(db, { adapter, claims: { sub: "other", email: "user@example.test", email_verified: true }, linkIntent: token, activeSession: { user: { id: userId, email: "user@example.test" }, session: { id: "session-1" } } })).toBe("/auth?oidcError=link_session_expired");
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("rejects non-boolean verification and email mismatch before issuing sessions", async () => {
    const now = new Date();
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "User", email: "local@example.test", emailVerified: true, createdAt: now, updatedAt: now });
    const createSession = vi.fn();
    const adapter = { findAccountByProviderId: vi.fn(async () => null), findUserByEmail: vi.fn(async () => null), createSession };
    expect(await callback(db, { adapter, claims: { sub: "subject", email: "local@example.test", email_verified: "true" } })).toBe("/auth?oidcError=unverified_email");
    const token = await createPaperclipOidcLinkIntent(db, { userId, sessionId: "session-1" }, now);
    expect(await callback(db, { adapter, claims: { sub: "subject", email: "remote@example.test", email_verified: true }, linkIntent: token, activeSession: { user: { id: userId, email: "local@example.test" }, session: { id: "session-1" } } })).toBe("/auth?oidcError=email_mismatch");
    expect(createSession).not.toHaveBeenCalled();
  });

  it("lets one concurrent callback bind and removes the losing new user", async () => {
    const now = new Date();
    const createSession = vi.fn(async (userId: string) => ({ id: `session-${userId}` }));
    const adapter = {
      findAccountByProviderId: vi.fn(async () => null),
      findUserByEmail: vi.fn(async () => null),
      createUser: vi.fn(async ({ email, name }: { email: string; name: string }) => {
        const user = { id: randomUUID(), email, name, emailVerified: true, createdAt: now, updatedAt: now };
        await db.insert(authUsers).values(user);
        return user;
      }),
      createSession,
    };
    const results = await Promise.all(["a@example.test", "b@example.test"].map((email) => callback(db, { adapter, claims: { sub: "shared", email, email_verified: true, name: email } })));
    expect(results.sort()).toEqual(["/", "/auth?oidcError=account_already_linked"].sort());
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(await db.select().from(authAccounts)).toHaveLength(1);
    expect(await db.select().from(authUsers)).toHaveLength(1);
  });

  it("denies subject conflicts and emits secret-free company-scoped link activity", async () => {
    const now = new Date();
    const currentId = randomUUID();
    const otherId = randomUUID();
    const companyId = randomUUID();
    await db.insert(authUsers).values([
      { id: currentId, name: "Current", email: "current@example.test", emailVerified: true, createdAt: now, updatedAt: now },
      { id: otherId, name: "Other", email: "other@example.test", emailVerified: true, createdAt: now, updatedAt: now },
    ]);
    await db.insert(companies).values({ id: companyId, name: "Company", issuePrefix: "OID" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: currentId, status: "active" });
    await db.insert(authAccounts).values({ id: randomUUID(), userId: otherId, providerId: "paperclip-id:https://id.example.test", accountId: "conflict", createdAt: now, updatedAt: now });
    const createSession = vi.fn(async () => ({ id: "new-session" }));
    const activeSession = { user: { id: currentId, email: "current@example.test" }, session: { id: "session-1" } };
    const conflict = await createPaperclipOidcLinkIntent(db, { userId: currentId, sessionId: "session-1" }, now);
    expect(await callback(db, { linkIntent: conflict, activeSession, claims: { sub: "conflict", email: "current@example.test", email_verified: true }, adapter: { findAccountByProviderId: vi.fn(async () => ({ userId: otherId })), findUserById: vi.fn(async () => ({ id: otherId, email: "other@example.test" })), createSession } })).toBe("/auth?oidcError=account_already_linked");
    expect(createSession).not.toHaveBeenCalled();
    const success = await createPaperclipOidcLinkIntent(db, { userId: currentId, sessionId: "session-1" }, now);
    expect(await callback(db, { linkIntent: success, activeSession, claims: { sub: "linked", email: "current@example.test", email_verified: true }, adapter: { findAccountByProviderId: vi.fn(async () => null), findUserByEmail: vi.fn(async () => null), createSession } })).toBe("/");
    const events = await db.select().from(activityLog);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ companyId, action: "auth.oidc_account_link_denied", details: { reason: "issuer_subject_conflict", providerId: "paperclip-id:https://id.example.test" } }),
      expect.objectContaining({ companyId, action: "auth.oidc_account_linked", details: { providerId: "paperclip-id:https://id.example.test" } }),
    ]));
    expect(JSON.stringify(events)).not.toMatch(/access-secret|refresh-secret|id-secret/);
  });
});
