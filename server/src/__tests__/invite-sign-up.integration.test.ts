/**
 * Invite-only sign-up end to end: the real Better Auth mount, the real actor
 * middleware and invite routes, and a migrated Postgres. Covers the three
 * sign-up modes and the full invited path (sign up with the invite token, then
 * accept the invite with the new session).
 */

import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  authAccounts,
  authSessions,
  authUsers,
  authVerifications,
  companies,
  createDb,
  invites,
  joinRequests,
} from "@paperclipai/db";
import type { AuthSignUpMode } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import type { Config } from "../config.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

const ORIGIN = "http://127.0.0.1:41998";
const PASSWORD = "correct-horse-battery-staple";
const TOKEN_HEADER = "x-paperclip-invite-token";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

function testConfig(authSignUpMode: AuthSignUpMode): Config {
  // Only the fields `createBetterAuthInstance` reads.
  return {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    authBaseUrlMode: "explicit",
    authPublicBaseUrl: ORIGIN,
    authSignUpMode,
    allowedHostnames: ["127.0.0.1"],
    port: 41998,
  } as unknown as Config;
}

function errorCode(res: request.Response): string | undefined {
  return res.body?.code ?? res.body?.error?.code;
}

function sessionCookieHeader(res: request.Response): string {
  const raw = res.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

describeEmbeddedPostgres("invite-only sign-up", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: Db;
  let companyId!: string;
  const apps = new Map<AuthSignUpMode, express.Express>();
  const originalEnv = {
    secret: process.env.BETTER_AUTH_SECRET,
    rateLimit: process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED,
  };

  async function buildApp(mode: AuthSignUpMode) {
    const { createBetterAuthHandler, createBetterAuthInstance, resolveBetterAuthSession } = await import(
      "../auth/better-auth.js"
    );
    const { actorMiddleware } = await import("../middleware/auth.js");
    const { accessRoutes } = await import("../routes/access.js");
    const auth = createBetterAuthInstance(db, testConfig(mode), [ORIGIN]);
    const app = express();
    // Mounted as `createApp` mounts it: before any body parser.
    app.all("/api/auth/{*authPath}", createBetterAuthHandler(auth));
    app.use(express.json());
    app.use(
      actorMiddleware(db, {
        deploymentMode: "authenticated",
        resolveSession: (req) => resolveBetterAuthSession(auth, req),
      }),
    );
    app.use(
      "/api",
      accessRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        bindHost: "127.0.0.1",
        allowedHostnames: ["127.0.0.1"],
      }),
    );
    app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(err.status ?? 500).json({ error: err.message ?? "Internal server error" });
    });
    return app;
  }

  async function createInvite(overrides: Partial<typeof invites.$inferInsert> = {}) {
    const token = `pcp_invite_${randomUUID()}`;
    const [invite] = await db
      .insert(invites)
      .values({
        companyId,
        inviteType: "company_join",
        tokenHash: createHash("sha256").update(token).digest("hex"),
        allowedJoinTypes: "human",
        defaultsPayload: null,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        invitedByUserId: null,
        ...overrides,
      })
      .returning();
    return { token, invite: invite! };
  }

  function signUp(mode: AuthSignUpMode, email: string, token?: string) {
    const req = request(apps.get(mode)!).post("/api/auth/sign-up/email").set("origin", ORIGIN);
    if (token) req.set(TOKEN_HEADER, token);
    return req.send({ email, password: PASSWORD, name: "Invitee" });
  }

  async function userExists(email: string) {
    const rows = await db.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.email, email));
    return rows.length > 0;
  }

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET = "better-auth-secret-for-invite-sign-up-tests";
    process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = "false";
    database = await startEmbeddedPostgresTestDatabase("paperclip-invite-sign-up-");
    db = createDb(database.connectionString);
    const [company] = await db
      .insert(companies)
      .values({ name: "Invite Only Co", issuePrefix: `IO${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}` })
      .returning();
    companyId = company!.id;
    for (const mode of ["open", "invite", "disabled"] as const) {
      apps.set(mode, await buildApp(mode));
    }
  }, 60_000);

  afterAll(async () => {
    await database?.cleanup();
    if (originalEnv.secret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = originalEnv.secret;
    if (originalEnv.rateLimit === undefined) delete process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED;
    else process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = originalEnv.rateLimit;
  });

  it("open mode still lets anyone sign up without a token", async () => {
    const res = await signUp("open", "open-mode@example.com");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await userExists("open-mode@example.com")).toBe(true);
  });

  it("disabled mode still rejects every sign-up, even one with a valid invite token", async () => {
    const { token } = await createInvite();
    const res = await signUp("disabled", "disabled-mode@example.com", token);
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("EMAIL_PASSWORD_SIGN_UP_DISABLED");
    expect(await userExists("disabled-mode@example.com")).toBe(false);
  });

  it("invite mode rejects a sign-up without a token and creates no user", async () => {
    const res = await signUp("invite", "no-token@example.com");
    expect(res.status).toBe(403);
    expect(errorCode(res)).toBe("SIGN_UP_REQUIRES_INVITE");
    expect(await userExists("no-token@example.com")).toBe(false);
  });

  it("invite mode answers a token-less sign-up for an existing email the same way, so emails cannot be probed", async () => {
    const res = await signUp("invite", "open-mode@example.com");
    expect(res.status).toBe(403);
    expect(errorCode(res)).toBe("SIGN_UP_REQUIRES_INVITE");
  });

  it("invite mode rejects unknown, revoked, expired and agent-only invite tokens with the same response", async () => {
    const revoked = await createInvite({ revokedAt: new Date() });
    const expired = await createInvite({ expiresAt: new Date(Date.now() - 1_000) });
    const agentOnly = await createInvite({ allowedJoinTypes: "agent" });
    const bodies = [];
    for (const token of ["pcp_invite_does_not_exist", revoked.token, expired.token, agentOnly.token]) {
      const res = await signUp("invite", "bad-token@example.com", token);
      expect(res.status).toBe(403);
      bodies.push(res.body);
    }
    expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
    expect(await userExists("bad-token@example.com")).toBe(false);
  });

  it("invite mode lets an invited person sign up, accept the invite, and then retires the token", async () => {
    const { token, invite } = await createInvite();

    const signUpRes = await signUp("invite", "invitee@example.com", token);
    expect(signUpRes.status, JSON.stringify(signUpRes.body)).toBe(200);
    const cookie = sessionCookieHeader(signUpRes);
    expect(cookie).toContain("session_token");

    const acceptRes = await request(apps.get("invite")!)
      .post(`/api/invites/${token}/accept`)
      .set("origin", ORIGIN)
      .set("cookie", cookie)
      .send({ requestType: "human" });
    expect(acceptRes.status, JSON.stringify(acceptRes.body)).toBeLessThan(300);

    const [user] = await db.select().from(authUsers).where(eq(authUsers.email, "invitee@example.com"));
    const requests = await db.select().from(joinRequests).where(eq(joinRequests.inviteId, invite.id));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ requestType: "human", requestingUserId: user!.id });
    const [acceptedInvite] = await db.select().from(invites).where(eq(invites.id, invite.id));
    expect(acceptedInvite!.acceptedAt).not.toBeNull();

    // An accepted invite cannot create more accounts.
    const reuse = await signUp("invite", "second-person@example.com", token);
    expect(reuse.status).toBe(403);
    expect(errorCode(reuse)).toBe("SIGN_UP_REQUIRES_INVITE");
    expect(await userExists("second-person@example.com")).toBe(false);
  });

  it("invite mode accepts a bootstrap invite token for the first admin", async () => {
    const { token } = await createInvite({
      companyId: null,
      inviteType: "bootstrap_ceo",
      invitedByUserId: "system",
    });
    const res = await signUp("invite", "first-admin@example.com", token);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("the user-creation hook alone blocks sign-up without a token", async () => {
    // Proves the backstop: with no `hooks.before` gate, Better Auth still runs
    // `databaseHooks.user.create.before` and the 403 reaches the caller.
    const { inviteSignUpAuthOptions } = await import("../auth/invite-sign-up-gate.js");
    const auth = betterAuth({
      baseURL: ORIGIN,
      secret: process.env.BETTER_AUTH_SECRET,
      trustedOrigins: [ORIGIN],
      database: drizzleAdapter(db, {
        provider: "pg",
        schema: { user: authUsers, session: authSessions, account: authAccounts, verification: authVerifications },
      }),
      emailAndPassword: { enabled: true, requireEmailVerification: false },
      rateLimit: { enabled: false },
      databaseHooks: inviteSignUpAuthOptions(db).databaseHooks,
    });
    const { createBetterAuthHandler } = await import("../auth/better-auth.js");
    const app = express();
    app.all("/api/auth/{*authPath}", createBetterAuthHandler(auth));

    const rejected = await request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .send({ email: "backstop@example.com", password: PASSWORD, name: "Backstop" });
    expect(rejected.status).toBe(403);
    expect(errorCode(rejected)).toBe("SIGN_UP_REQUIRES_INVITE");
    expect(await userExists("backstop@example.com")).toBe(false);

    const { token } = await createInvite();
    const allowed = await request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .set(TOKEN_HEADER, token)
      .send({ email: "backstop@example.com", password: PASSWORD, name: "Backstop" });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
  });
});
