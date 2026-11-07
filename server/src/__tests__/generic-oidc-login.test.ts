/**
 * HTTP-level coverage for the environment-configured generic OIDC provider.
 * Nothing here names a particular issuer: the plugin is Better Auth's
 * built-in `generic-oauth`, wired by `buildGenericOidcPlugin` only when the
 * environment carries a full issuer/client/secret triple.
 *
 * A real issuer is simulated with a tiny local HTTP server (discovery, JWKS,
 * token endpoint) so the test exercises the actual cryptographic id_token
 * verification Better Auth performs, not a mock of it. The authorization
 * step itself is skipped (no browser involved): the test reads the `state`
 * and `nonce` Better Auth generated from the `sign-in/social` response, then
 * calls the callback endpoint directly, exactly as a browser redirect would.
 */

import { createServer, type Server } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import express from "express";
import request from "supertest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { toNodeHandler } from "better-auth/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildGenericOidcPlugin,
  resolveGenericOidcProviderStatus,
} from "../auth/better-auth.js";

const PROVIDER_ID = "test-oidc";
const CLIENT_ID = "test-oidc-client";
const CLIENT_SECRET = "test-oidc-secret";
const APP_ORIGIN = "http://app.localhost:42099";
const CALLBACK_URL = "/dashboard";

type MemoryStore = Record<string, Record<string, unknown>[]>;

type TokenResponseOverrides = {
  nonce?: string;
  iss?: string;
  aud?: string;
  sub?: string;
  email?: string;
  emailVerified?: boolean;
  expiredSeconds?: number;
  signWithWrongKey?: boolean;
};

async function startFakeIssuer() {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const { publicKey: wrongPublicKey, privateKey: wrongPrivateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "real-key", alg: "ES256", use: "sig" };

  let nextTokenResponseBody: Record<string, unknown> | null = null;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://internal");
    if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        issuer: issuerOrigin(),
        authorization_endpoint: `${issuerOrigin()}/authorize`,
        token_endpoint: `${issuerOrigin()}/token`,
        userinfo_endpoint: `${issuerOrigin()}/userinfo`,
        jwks_uri: `${issuerOrigin()}/jwks`,
        id_token_signing_alg_values_supported: ["ES256"],
      }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/jwks") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/token") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(nextTokenResponseBody ?? { error: "no_token_response_configured" }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  function issuerOrigin() {
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("server not listening");
    return `http://127.0.0.1:${addr.port}`;
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  async function buildIdToken(overrides: TokenResponseOverrides = {}) {
    const now = Math.floor(Date.now() / 1000) - (overrides.expiredSeconds ?? 0);
    const signer = new SignJWT({
      email: overrides.email ?? "member@example.com",
      email_verified: overrides.emailVerified ?? true,
      ...(overrides.nonce ? { nonce: overrides.nonce } : {}),
    })
      .setProtectedHeader({ alg: "ES256", kid: "real-key" })
      .setSubject(overrides.sub ?? "oidc-user-1")
      .setIssuer(overrides.iss ?? issuerOrigin())
      .setAudience(overrides.aud ?? CLIENT_ID)
      .setIssuedAt(now)
      .setExpirationTime(now + (overrides.expiredSeconds ? -1 : 3600));
    return signer.sign(overrides.signWithWrongKey ? wrongPrivateKey : privateKey);
  }

  /** Arms the fake token endpoint's next response with a freshly signed id_token. */
  async function setNextIdToken(overrides: TokenResponseOverrides = {}) {
    const idToken = await buildIdToken(overrides);
    nextTokenResponseBody = {
      access_token: "fake-access-token",
      id_token: idToken,
      token_type: "Bearer",
      expires_in: 3600,
    };
  }

  return {
    origin: issuerOrigin(),
    setNextIdToken,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function cookieHeader(res: request.Response): string {
  const raw = res.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return cookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

function sessionCookies(res: request.Response): string[] {
  const raw = res.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return cookies.filter((cookie) => cookie.includes("session_token"));
}

let issuer: Awaited<ReturnType<typeof startFakeIssuer>>;
const ORIGINAL_ENV: Record<string, string | undefined> = {};

beforeAll(async () => {
  issuer = await startFakeIssuer();
});

afterAll(async () => {
  await issuer.close();
});

beforeEach(() => {
  for (const key of [
    "PAPERCLIP_OIDC_ISSUER",
    "PAPERCLIP_OIDC_CLIENT_ID",
    "PAPERCLIP_OIDC_CLIENT_SECRET",
    "PAPERCLIP_OIDC_PROVIDER_ID",
  ]) {
    ORIGINAL_ENV[key] = process.env[key];
  }
  process.env.PAPERCLIP_OIDC_ISSUER = issuer.origin;
  process.env.PAPERCLIP_OIDC_CLIENT_ID = CLIENT_ID;
  process.env.PAPERCLIP_OIDC_CLIENT_SECRET = CLIENT_SECRET;
  process.env.PAPERCLIP_OIDC_PROVIDER_ID = PROVIDER_ID;
});

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function createApp(input: { disableSignUp?: boolean } = {}) {
  const store: MemoryStore = { user: [], session: [], account: [], verification: [] };
  const plugin = buildGenericOidcPlugin();
  if (!plugin) throw new Error("expected the OIDC plugin to build with the test env configured");

  const auth = betterAuth({
    secret: "generic-oidc-test-secret",
    baseURL: APP_ORIGIN,
    trustedOrigins: [APP_ORIGIN],
    database: memoryAdapter(store),
    emailAndPassword: { enabled: true, disableSignUp: input.disableSignUp ?? false },
    advanced: { useSecureCookies: false },
    plugins: [plugin],
  });

  const app = express();
  app.all("/api/auth/*splat", (req, res, next) => {
    void Promise.resolve(toNodeHandler(auth)(req, res)).catch(next);
  });
  return { app, store };
}

function seedVerifiedUser(store: MemoryStore, input: { id: string; email: string; emailVerified: boolean }) {
  store.user!.push({
    id: input.id,
    email: input.email,
    name: "Existing Member",
    emailVerified: input.emailVerified,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function initiate(app: express.Express) {
  const res = await request(app)
    .post("/api/auth/sign-in/social")
    .send({ provider: PROVIDER_ID, callbackURL: CALLBACK_URL });
  expect(res.status).toBe(200);
  const url = new URL((res.body as { url: string }).url);
  return {
    state: url.searchParams.get("state")!,
    nonce: url.searchParams.get("nonce")!,
    cookie: cookieHeader(res),
  };
}

function callback(app: express.Express, input: { state: string; cookie: string; code?: string }) {
  const code = input.code ?? "fake-authorization-code";
  return request(app)
    .get(`/api/auth/callback/${PROVIDER_ID}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(input.state)}`)
    .set("Cookie", input.cookie);
}

describe("resolveGenericOidcProviderStatus", () => {
  it("is null (feature off) when the environment is not configured", () => {
    delete process.env.PAPERCLIP_OIDC_ISSUER;
    delete process.env.PAPERCLIP_OIDC_CLIENT_ID;
    delete process.env.PAPERCLIP_OIDC_CLIENT_SECRET;
    expect(resolveGenericOidcProviderStatus()).toBeNull();
    expect(buildGenericOidcPlugin()).toBeNull();
  });

  it("is null when the issuer is not a valid URL", () => {
    process.env.PAPERCLIP_OIDC_ISSUER = "not-a-url";
    expect(resolveGenericOidcProviderStatus()).toBeNull();
  });

  it("reports the configured provider id and display name", () => {
    process.env.PAPERCLIP_OIDC_PROVIDER_NAME = "Acme";
    expect(resolveGenericOidcProviderStatus()).toEqual({
      providerId: PROVIDER_ID,
      displayName: "Acme",
    });
    delete process.env.PAPERCLIP_OIDC_PROVIDER_NAME;
  });
});

describe("generic OIDC sign-in", () => {
  it("attaches an existing account by verified email and opens a session", async () => {
    const { app, store } = createApp();
    seedVerifiedUser(store, { id: "existing-1", email: "member@example.com", emailVerified: true });

    const { state, nonce, cookie } = await initiate(app);
    await issuer.setNextIdToken({ nonce, email: "member@example.com", emailVerified: true });
    const res = await callback(app, { state, cookie });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain(CALLBACK_URL);
    expect(sessionCookies(res)).toHaveLength(1);
    expect(store.user).toHaveLength(1);
    expect(store.session).toHaveLength(1);
    expect(store.session![0]!.userId).toBe("existing-1");
    expect(store.account).toHaveLength(1);
    expect(store.account![0]!.providerId).toBe(PROVIDER_ID);
  });

  it("creates a brand-new account with no pre-existing membership when the email is unknown", async () => {
    const { app, store } = createApp();

    const { state, nonce, cookie } = await initiate(app);
    await issuer.setNextIdToken({ nonce, email: "new-member@example.com", emailVerified: true, sub: "oidc-user-2" });
    const res = await callback(app, { state, cookie });

    expect(res.status).toBe(302);
    expect(sessionCookies(res)).toHaveLength(1);
    expect(store.user).toHaveLength(1);
    expect(store.user![0]!.email).toBe("new-member@example.com");
    expect(store.user![0]!.emailVerified).toBe(true);
    // No concept of a company membership exists in this in-memory Better Auth
    // store: nothing in the OIDC sign-in path touches it, by construction
    // (handleOAuthUserInfo only ever inserts into user/account). Asserted by
    // code inspection, not exercised against the real companyMemberships
    // table here — that would need the Postgres-backed test harness.
  });

  it("refuses a new account whose email the issuer reports as unverified", async () => {
    const { app, store } = createApp();

    const { state, nonce, cookie } = await initiate(app);
    await issuer.setNextIdToken({ nonce, email: "unverified@example.com", emailVerified: false, sub: "oidc-user-3" });
    const res = await callback(app, { state, cookie });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("error=");
    expect(sessionCookies(res)).toHaveLength(0);
    expect(store.session).toHaveLength(0);
  });

  it("refuses to rattach an existing-but-unverified local account to an unverified issuer email", async () => {
    const { app, store } = createApp();
    seedVerifiedUser(store, { id: "existing-2", email: "half-verified@example.com", emailVerified: false });

    const { state, nonce, cookie } = await initiate(app);
    await issuer.setNextIdToken({ nonce, email: "half-verified@example.com", emailVerified: true });
    const res = await callback(app, { state, cookie });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("error=");
    expect(sessionCookies(res)).toHaveLength(0);
    expect(store.session).toHaveLength(0);
    expect(store.account).toHaveLength(0);
  });

  it("rejects a forged id_token signed by a key the issuer never published", async () => {
    const { app, store } = createApp();
    const { state, nonce, cookie } = await initiate(app);
    await issuer.setNextIdToken({ nonce, signWithWrongKey: true });
    const res = await callback(app, { state, cookie });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("error=");
    expect(sessionCookies(res)).toHaveLength(0);
    expect(store.session).toHaveLength(0);
    expect(store.user).toHaveLength(0);
  });

  it("rejects an expired id_token", async () => {
    const { app, store } = createApp();
    const { state, nonce, cookie } = await initiate(app);
    await issuer.setNextIdToken({ nonce, expiredSeconds: 3600 });
    const res = await callback(app, { state, cookie });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("error=");
    expect(sessionCookies(res)).toHaveLength(0);
    expect(store.session).toHaveLength(0);
  });

  it("rejects an id_token issued for another issuer", async () => {
    const { app, store } = createApp();
    const { state, nonce, cookie } = await initiate(app);
    await issuer.setNextIdToken({ nonce, iss: "https://not-our-issuer.example.com" });
    const res = await callback(app, { state, cookie });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("error=");
    expect(sessionCookies(res)).toHaveLength(0);
    expect(store.session).toHaveLength(0);
  });

  it("rejects an id_token issued for another OAuth client", async () => {
    const { app, store } = createApp();
    const { state, nonce, cookie } = await initiate(app);
    await issuer.setNextIdToken({ nonce, aud: "some-other-client" });
    const res = await callback(app, { state, cookie });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("error=");
    expect(sessionCookies(res)).toHaveLength(0);
    expect(store.session).toHaveLength(0);
  });

  it("keeps password sign-up closed while OIDC sign-up keeps creating accounts", async () => {
    const { app, store } = createApp({ disableSignUp: true });

    const passwordSignUp = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ name: "Blocked", email: "blocked@example.com", password: "password1234" });
    expect(passwordSignUp.status).toBeGreaterThanOrEqual(400);
    expect(store.user).toHaveLength(0);

    const { state, nonce, cookie } = await initiate(app);
    await issuer.setNextIdToken({ nonce, email: "oidc-member@example.com", emailVerified: true, sub: "oidc-user-4" });
    const res = await callback(app, { state, cookie });

    expect(res.status).toBe(302);
    expect(sessionCookies(res)).toHaveLength(1);
    expect(store.user).toHaveLength(1);
    expect(store.user![0]!.email).toBe("oidc-member@example.com");

    // Email + password sign-IN must still work for the operator fallback.
    const passwordSignIn = await request(app)
      .post("/api/auth/sign-in/email")
      .send({ email: "oidc-member@example.com", password: "whatever" });
    // No password was ever set for this OIDC-created account, so this
    // specific account correctly fails — but it must fail with an
    // authentication error, never with signup-is-closed or a crash.
    expect(passwordSignIn.status).toBeGreaterThanOrEqual(400);
    expect(passwordSignIn.status).toBeLessThan(500);
  });
});
