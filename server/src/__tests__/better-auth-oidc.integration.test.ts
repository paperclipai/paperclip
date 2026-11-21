import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { authAccounts, authUsers, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createBetterAuthHandler, createBetterAuthInstance } from "../auth/better-auth.js";
import type { Config } from "../config.js";

const ORIGIN = "http://127.0.0.1:41998";
const IDP = "https://idp.example.test";
const KNOWN_EMAIL = "founder@example.com";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function sessionCookies(response: request.Response): string[] {
  const raw = response.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return cookies.filter((cookie) => cookie.includes("session_token") && !/Max-Age=0/i.test(cookie));
}

describeEmbeddedPostgres("Better Auth OpenID Connect callback against the real schema", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let app!: express.Express;
  let profile: Record<string, unknown> = {};
  const originalEnv = {
    secret: process.env.BETTER_AUTH_SECRET,
    client: process.env.PAPERCLIP_AUTH_OIDC_CLIENT_SECRET,
    rateLimit: process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED,
  };

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET = "better-auth-secret-for-oidc-callback-tests";
    process.env.PAPERCLIP_AUTH_OIDC_CLIENT_SECRET = "client-secret";
    process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = "false";
    database = await startEmbeddedPostgresTestDatabase("paperclip-better-auth-oidc-");
    db = createDb(database.connectionString);
    const config = {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: ORIGIN,
      authDisableSignUp: false,
      allowedHostnames: ["127.0.0.1"],
      port: 41998,
      authOidc: {
        providerId: "idp",
        displayName: "Company sign-in",
        discoveryUrl: `${IDP}/.well-known/openid-configuration`,
        clientId: "paperclip",
      },
    } as unknown as Config;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) {
        return Response.json({
          issuer: IDP,
          authorization_endpoint: `${IDP}/authorize`,
          token_endpoint: `${IDP}/token`,
          userinfo_endpoint: `${IDP}/userinfo`,
          id_token_signing_alg_values_supported: ["ES256"],
        });
      }
      if (url === `${IDP}/token`) return Response.json({ access_token: "token", token_type: "Bearer" });
      if (url === `${IDP}/userinfo`) return Response.json(profile);
      throw new Error(`unexpected fetch ${url}`);
    }));
    app = express();
    app.all("/api/auth/{*authPath}", createBetterAuthHandler(createBetterAuthInstance(db, config, [ORIGIN])));
    const now = new Date();
    await db.insert(authUsers).values({ id: "founder", name: "Founder", email: KNOWN_EMAIL, emailVerified: true, createdAt: now, updatedAt: now });
  }, 60_000);

  afterEach(() => {
    profile = {};
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await database?.cleanup();
    for (const [key, value] of [
      ["BETTER_AUTH_SECRET", originalEnv.secret],
      ["PAPERCLIP_AUTH_OIDC_CLIENT_SECRET", originalEnv.client],
      ["PAPERCLIP_AUTH_RATE_LIMIT_ENABLED", originalEnv.rateLimit],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function signInWithProvider(claims: Record<string, unknown>) {
    profile = { sub: "subject-1", name: "Person", ...claims };
    const start = await request(app)
      .post("/api/auth/sign-in/social")
      .set("origin", ORIGIN)
      .send({ provider: "idp", callbackURL: "/" });
    expect(start.status).toBe(200);
    const state = new URL(start.body.url).searchParams.get("state")!;
    const cookies = (start.headers["set-cookie"] as unknown as string[]).map((cookie) => cookie.split(";")[0]);
    return request(app)
      .get("/api/auth/callback/idp")
      .query({ code: "code", state })
      .set("cookie", cookies.join("; "));
  }

  it("signs in the existing user whose email the provider verified", async () => {
    const callback = await signInWithProvider({ email: KNOWN_EMAIL, email_verified: true });
    expect(sessionCookies(callback).length).toBeGreaterThan(0);
    const accounts = await db.select().from(authAccounts);
    expect(accounts.some((account) => account.providerId === "idp")).toBe(true);
  });

  it("does not sign in an email the provider has not verified", async () => {
    const before = (await db.select().from(authAccounts)).length;
    const callback = await signInWithProvider({ email: KNOWN_EMAIL, email_verified: false, sub: "subject-2" });
    expect(sessionCookies(callback)).toHaveLength(0);
    expect(await db.select().from(authAccounts)).toHaveLength(before);
  });

  it("does not link an account whose own email is unverified", async () => {
    const now = new Date();
    await db.insert(authUsers).values({ id: "pending", name: "Pending", email: "pending@example.com", emailVerified: false, createdAt: now, updatedAt: now });
    const before = (await db.select().from(authAccounts)).length;
    const callback = await signInWithProvider({ email: "pending@example.com", email_verified: true, sub: "subject-4" });
    expect(sessionCookies(callback)).toHaveLength(0);
    expect(await db.select().from(authAccounts)).toHaveLength(before);
  });

  it("does not create a user for an unknown email", async () => {
    const callback = await signInWithProvider({ email: "stranger@example.com", email_verified: true, sub: "subject-3" });
    expect(sessionCookies(callback)).toHaveLength(0);
    const users = await db.select().from(authUsers);
    expect(users.map((user) => user.email)).not.toContain("stranger@example.com");
  });
});
