/**
 * End-to-end coverage for the credential sign-up and sign-in that a
 * self-hosted install depends on, driven through the real Better Auth mount
 * against the real Drizzle schema and a migrated Postgres.
 *
 * The other Better Auth suites mount either a stub handler or the in-memory
 * adapter, so neither notices when Better Auth's `account` model grows a field
 * the Drizzle table does not have. The Drizzle adapter validates the model
 * against the schema on every write and throws
 * `The field "<name>" does not exist in the "account" Drizzle schema`, which
 * the mount turns into a 500 with an empty body — a fresh install cannot
 * create its first user at all. This suite is the one that fails when that
 * happens.
 */

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authAccounts, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createBetterAuthHandler, createBetterAuthInstance } from "../auth/better-auth.js";
import type { Config } from "../config.js";

const ORIGIN = "http://127.0.0.1:41999";
const EMAIL = "founder@example.com";
const PASSWORD = "correct-horse-battery-staple";

// The issuer Better Auth stamps on an email/password account:
// `createLocalAccountIssuer("credential")`. Sign-in matches on it, so a row
// written with anything else is a row nobody can sign in as.
const CREDENTIAL_ISSUER = "local:credential";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function testConfig(): Config {
  // Only the auth-relevant fields are read by `createBetterAuthInstance`; the
  // rest of `Config` describes storage, backups, and scheduling that the Better
  // Auth instance never looks at.
  return {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    authBaseUrlMode: "explicit",
    authPublicBaseUrl: ORIGIN,
    authDisableSignUp: false,
    allowedHostnames: ["127.0.0.1"],
    port: 41999,
  } as unknown as Config;
}

function sessionCookies(response: request.Response): string[] {
  const raw = response.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return cookies.filter((cookie) => cookie.includes("session_token"));
}

describeEmbeddedPostgres("Better Auth credential sign-up against the real schema", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let app!: express.Express;
  const originalEnv = {
    secret: process.env.BETTER_AUTH_SECRET,
    rateLimit: process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED,
  };

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET = "better-auth-secret-for-credential-signup-tests";
    // The rate limiter is on by default in `authenticated` mode and would score
    // the sign-up and sign-in this suite issues back to back.
    process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = "false";

    database = await startEmbeddedPostgresTestDatabase("paperclip-better-auth-signup-");
    db = createDb(database.connectionString);

    const auth = createBetterAuthInstance(db, testConfig(), [ORIGIN]);
    app = express();
    // Mounted exactly as `createApp` mounts it, and with no body parser in
    // front of it: Better Auth reads the raw request body itself.
    app.all("/api/auth/{*authPath}", createBetterAuthHandler(auth));
  }, 30_000);

  afterAll(async () => {
    await database?.cleanup();
    if (originalEnv.secret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = originalEnv.secret;
    if (originalEnv.rateLimit === undefined) delete process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED;
    else process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = originalEnv.rateLimit;
  });

  it("creates the user and its credential account, then signs that user in", async () => {
    const signUp = await request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .send({ email: EMAIL, password: PASSWORD, name: "Founder" });

    // A missing `account` column fails here with a 500 and an empty body.
    expect(signUp.status).toBe(200);
    expect(signUp.body?.user?.email).toBe(EMAIL);

    // Sign-up has to leave a usable account row behind. A half-created user —
    // a `user` row with no `account` — cannot sign in, cannot sign up again,
    // and cannot reset its password.
    const accounts = await db.select().from(authAccounts);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      providerId: "credential",
      issuer: CREDENTIAL_ISSUER,
    });
    expect(accounts[0]?.password).toBeTruthy();

    const signIn = await request(app)
      .post("/api/auth/sign-in/email")
      .set("origin", ORIGIN)
      .send({ email: EMAIL, password: PASSWORD });

    expect(signIn.status).toBe(200);
    expect(signIn.body?.user?.email).toBe(EMAIL);
    expect(sessionCookies(signIn).length).toBeGreaterThan(0);
  });
});
