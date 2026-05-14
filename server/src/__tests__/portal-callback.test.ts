import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  eq: (_col: unknown, value: string) => ({ __email: value }),
}));
vi.mock("@paperclipai/db", () => ({
  authUsers: { __name: "user", email: "email", id: "id" },
  authSessions: { __name: "session" },
}));

import { errorHandler } from "../middleware/index.js";
import { isSafeRedirectTarget, portalCallbackRoutes } from "../routes/portal-callback.js";

const PORTAL_SECRET = "portal-secret-for-tests";
const COOKIE_SECRET = "cookie-secret-for-tests";
const COOKIE_NAME_PREFIX = "paperclip-default";

const originalEnv = {
  portalSecret: process.env.WBIT_PORTAL_JWT_SECRET,
  betterAuthSecret: process.env.BETTER_AUTH_SECRET,
  paperclipAgentSecret: process.env.PAPERCLIP_AGENT_JWT_SECRET,
  instanceId: process.env.PAPERCLIP_INSTANCE_ID,
};

beforeEach(() => {
  process.env.WBIT_PORTAL_JWT_SECRET = PORTAL_SECRET;
  process.env.BETTER_AUTH_SECRET = COOKIE_SECRET;
  delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
  delete process.env.PAPERCLIP_INSTANCE_ID;
});

afterEach(() => {
  if (originalEnv.portalSecret === undefined) delete process.env.WBIT_PORTAL_JWT_SECRET;
  else process.env.WBIT_PORTAL_JWT_SECRET = originalEnv.portalSecret;
  if (originalEnv.betterAuthSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = originalEnv.betterAuthSecret;
  if (originalEnv.paperclipAgentSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
  else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalEnv.paperclipAgentSecret;
  if (originalEnv.instanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
  else process.env.PAPERCLIP_INSTANCE_ID = originalEnv.instanceId;
});

function base64Url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

interface PortalClaimsInput {
  sub?: string;
  email?: string;
  name?: string;
  app_access?: string[];
  iat?: number;
  exp?: number;
}

function makePortalJwt(claims: PortalClaimsInput, opts?: { secret?: string; alg?: string }): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: opts?.alg ?? "HS256", typ: "JWT" };
  const payload = {
    sub: claims.sub ?? "portal-user-1",
    email: claims.email ?? "operator@example.com",
    name: claims.name,
    app_access: claims.app_access ?? ["CORTEX"],
    iat: claims.iat ?? now,
    exp: claims.exp ?? now + 60,
  };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = createHmac("sha256", opts?.secret ?? PORTAL_SECRET)
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}

interface FakeUserRow {
  id: string;
  email: string;
  name: string;
}

interface FakeDbState {
  users: FakeUserRow[];
  sessions: { id: string; token: string; userId: string }[];
  userInsertCount: number;
}

function createFakeDb(initial: FakeUserRow[] = []) {
  const state: FakeDbState = { users: [...initial], sessions: [], userInsertCount: 0 };

  const db = {
    select() {
      return {
        from(_table: unknown) {
          return {
            where(predicate: { __email?: string }) {
              const email = predicate.__email;
              const rows = email
                ? state.users.filter((u) => u.email === email).map((u) => ({ id: u.id }))
                : [];
              return Promise.resolve(rows);
            },
          };
        },
      };
    },
    insert(table: { __name: string }) {
      return {
        values(row: Record<string, unknown>) {
          if (table.__name === "user") {
            state.userInsertCount += 1;
            state.users.push({
              id: String(row.id),
              email: String(row.email),
              name: String(row.name),
            });
          } else if (table.__name === "session") {
            state.sessions.push({
              id: String(row.id),
              token: String(row.token),
              userId: String(row.userId),
            });
          }
          return Promise.resolve();
        },
      };
    },
  };

  return { db: db as unknown as Parameters<typeof portalCallbackRoutes>[0], state };
}

function createApp(db: Parameters<typeof portalCallbackRoutes>[0]) {
  const app = express();
  app.use(portalCallbackRoutes(db));
  app.use(errorHandler);
  return app;
}

describe.sequential("portal-callback route", () => {
  it("provisions a new user and sets a signed session cookie on valid CORTEX JWT", async () => {
    const { db, state } = createFakeDb();
    const app = createApp(db);
    const token = makePortalJwt({ email: "new-user@example.com", name: "New User" });

    const res = await request(app).get("/cortex/auth/callback").query({ token });

    expect(res.status).toBe(302);
    expect(res.header.location).toBe("/");
    expect(state.userInsertCount).toBe(1);
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0].userId).toBe(state.users[0].id);
    expect(state.users[0].email).toBe("new-user@example.com");

    const cookieHeader = res.header["set-cookie"];
    expect(Array.isArray(cookieHeader)).toBe(true);
    const cookie = (cookieHeader as string[])[0];
    expect(cookie).toContain(`${COOKIE_NAME_PREFIX}.session_token=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
  });

  it("returns 403 when CORTEX is missing from app_access", async () => {
    const { db, state } = createFakeDb();
    const app = createApp(db);
    const token = makePortalJwt({ app_access: ["AGENCY_OS", "WORKPIPE"] });

    const res = await request(app).get("/cortex/auth/callback").query({ token });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("entitlement_denied");
    expect(state.sessions).toHaveLength(0);
    expect(state.users).toHaveLength(0);
  });

  it("returns 403 for expired JWTs", async () => {
    const { db, state } = createFakeDb();
    const app = createApp(db);
    const past = Math.floor(Date.now() / 1000) - 120;
    const token = makePortalJwt({ iat: past - 60, exp: past });

    const res = await request(app).get("/cortex/auth/callback").query({ token });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("expired");
    expect(state.sessions).toHaveLength(0);
  });

  it("returns 403 for a JWT signed with the wrong secret", async () => {
    const { db, state } = createFakeDb();
    const app = createApp(db);
    const token = makePortalJwt({}, { secret: "wrong-secret" });

    const res = await request(app).get("/cortex/auth/callback").query({ token });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("bad_signature");
    expect(state.sessions).toHaveLength(0);
  });

  it("returns 400 when token query param is missing", async () => {
    const { db, state } = createFakeDb();
    const app = createApp(db);

    const res = await request(app).get("/cortex/auth/callback");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_token");
    expect(state.sessions).toHaveLength(0);
  });

  it("falls back to / for open-redirect attempts (protocol-relative, absolute URL, path traversal)", async () => {
    const { db } = createFakeDb();
    const app = createApp(db);
    const token = makePortalJwt({});
    const hostileTargets = [
      "//evil.com/path",
      "https://evil.com",
      "http://evil.com",
      "\\\\evil.com",
      "javascript:alert(1)",
      "evil.com/path",
    ];
    for (const target of hostileTargets) {
      const res = await request(app)
        .get("/cortex/auth/callback")
        .query({ token, redirect_to: target });
      expect(res.status).toBe(302);
      expect(res.header.location).toBe("/");
    }
  });

  it("honors safe relative redirect_to values", async () => {
    const { db } = createFakeDb();
    const app = createApp(db);
    const token = makePortalJwt({});

    const res = await request(app)
      .get("/cortex/auth/callback")
      .query({ token, redirect_to: "/projects/42?tab=tasks" });

    expect(res.status).toBe(302);
    expect(res.header.location).toBe("/projects/42?tab=tasks");
  });

  it("reuses the existing user row for returning users (no duplicate insert)", async () => {
    const { db, state } = createFakeDb([
      { id: "existing-user-1", email: "returning@example.com", name: "Returning" },
    ]);
    const app = createApp(db);
    const token = makePortalJwt({ email: "returning@example.com" });

    const res = await request(app).get("/cortex/auth/callback").query({ token });

    expect(res.status).toBe(302);
    expect(state.userInsertCount).toBe(0);
    expect(state.users).toHaveLength(1);
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0].userId).toBe("existing-user-1");
  });
});

describe("isSafeRedirectTarget", () => {
  it("accepts simple absolute paths", () => {
    expect(isSafeRedirectTarget("/")).toBe(true);
    expect(isSafeRedirectTarget("/foo/bar")).toBe(true);
    expect(isSafeRedirectTarget("/foo?x=1#frag")).toBe(true);
  });

  it("rejects protocol-relative URLs and absolute URLs", () => {
    expect(isSafeRedirectTarget("//evil.com")).toBe(false);
    expect(isSafeRedirectTarget("https://evil.com")).toBe(false);
    expect(isSafeRedirectTarget("http://evil.com")).toBe(false);
  });

  it("rejects empty / non-string / backslash-laced inputs", () => {
    expect(isSafeRedirectTarget("")).toBe(false);
    expect(isSafeRedirectTarget(undefined)).toBe(false);
    expect(isSafeRedirectTarget(null)).toBe(false);
    expect(isSafeRedirectTarget("/path\\\\with-backslash")).toBe(false);
  });
});
