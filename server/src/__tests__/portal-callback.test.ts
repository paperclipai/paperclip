import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  eq: (col: { __col?: string } | unknown, value: unknown) => {
    const colName = (col as { __col?: string })?.__col;
    return { __op: "eq", __col: colName, __value: value };
  },
  and: (...clauses: unknown[]) => ({ __op: "and", __clauses: clauses }),
}));
vi.mock("@paperclipai/db", () => ({
  authUsers: { __name: "user", email: { __col: "email" }, id: { __col: "id" } },
  authSessions: { __name: "session" },
  companies: { __name: "company", id: { __col: "id" } },
  companyMemberships: {
    __name: "membership",
    id: { __col: "id" },
    companyId: { __col: "companyId" },
    principalType: { __col: "principalType" },
    principalId: { __col: "principalId" },
  },
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
  org_id?: string;
  org_name?: string;
}

function makePortalJwt(claims: PortalClaimsInput, opts?: { secret?: string; alg?: string }): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: opts?.alg ?? "HS256", typ: "JWT" };
  const payload: Record<string, unknown> = {
    sub: claims.sub ?? "portal-user-1",
    email: claims.email ?? "operator@example.com",
    name: claims.name,
    app_access: claims.app_access ?? ["CORTEX"],
    iat: claims.iat ?? now,
    exp: claims.exp ?? now + 60,
  };
  if (claims.org_id !== undefined) payload.org_id = claims.org_id;
  if (claims.org_name !== undefined) payload.org_name = claims.org_name;
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

interface FakeCompanyRow {
  id: string;
  name: string;
}

interface FakeMembershipRow {
  id: string;
  companyId: string;
  principalType: string;
  principalId: string;
  status: string;
  membershipRole: string | null;
}

interface FakeDbState {
  users: FakeUserRow[];
  sessions: { id: string; token: string; userId: string }[];
  companies: FakeCompanyRow[];
  memberships: FakeMembershipRow[];
  userInsertCount: number;
  companyInsertCount: number;
  membershipInsertCount: number;
}

interface EqClause {
  __op: "eq";
  __col?: string;
  __value: unknown;
}

interface AndClause {
  __op: "and";
  __clauses: unknown[];
}

function evalClause(row: Record<string, unknown>, clause: unknown): boolean {
  if (!clause || typeof clause !== "object") return true;
  const c = clause as Partial<EqClause & AndClause>;
  if (c.__op === "and" && Array.isArray(c.__clauses)) {
    return c.__clauses.every((sub) => evalClause(row, sub));
  }
  if (c.__op === "eq" && c.__col) {
    return row[c.__col] === c.__value;
  }
  return true;
}

function createFakeDb(initial?: {
  users?: FakeUserRow[];
  companies?: FakeCompanyRow[];
  memberships?: FakeMembershipRow[];
}) {
  const state: FakeDbState = {
    users: [...(initial?.users ?? [])],
    sessions: [],
    companies: [...(initial?.companies ?? [])],
    memberships: [...(initial?.memberships ?? [])],
    userInsertCount: 0,
    companyInsertCount: 0,
    membershipInsertCount: 0,
  };

  let membershipIdCounter = state.memberships.length;

  function tableRows(name: string): Record<string, unknown>[] {
    if (name === "user") return state.users as unknown as Record<string, unknown>[];
    if (name === "company") return state.companies as unknown as Record<string, unknown>[];
    if (name === "membership")
      return state.memberships as unknown as Record<string, unknown>[];
    return [];
  }

  const db = {
    select(projection?: Record<string, { __col?: string }>) {
      return {
        from(table: { __name: string }) {
          return {
            where(predicate: unknown) {
              const rows = tableRows(table.__name).filter((row) => evalClause(row, predicate));
              const projected = rows.map((row) => {
                if (!projection) return row;
                const out: Record<string, unknown> = {};
                for (const [outKey, col] of Object.entries(projection)) {
                  const sourceKey = col?.__col;
                  out[outKey] = sourceKey ? row[sourceKey] : undefined;
                }
                return out;
              });
              return Promise.resolve(projected);
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
          } else if (table.__name === "company") {
            state.companyInsertCount += 1;
            state.companies.push({
              id: String(row.id),
              name: String(row.name),
            });
          } else if (table.__name === "membership") {
            state.membershipInsertCount += 1;
            membershipIdCounter += 1;
            state.memberships.push({
              id: `mem-${membershipIdCounter}`,
              companyId: String(row.companyId),
              principalType: String(row.principalType),
              principalId: String(row.principalId),
              status: String(row.status),
              membershipRole:
                row.membershipRole === null || row.membershipRole === undefined
                  ? null
                  : String(row.membershipRole),
            });
          }
          return Promise.resolve();
        },
      };
    },
  };

  return { db: db as unknown as Parameters<typeof portalCallbackRoutes>[0], state };
}

const DEFAULT_PORTAL_COMPANY_ID = "00000000-0000-4000-a000-00000000c0de";

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
    const { db, state } = createFakeDb({
      users: [{ id: "existing-user-1", email: "returning@example.com", name: "Returning" }],
    });
    const app = createApp(db);
    const token = makePortalJwt({ email: "returning@example.com" });

    const res = await request(app).get("/cortex/auth/callback").query({ token });

    expect(res.status).toBe(302);
    expect(state.userInsertCount).toBe(0);
    expect(state.users).toHaveLength(1);
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0].userId).toBe("existing-user-1");
  });

  it("new user with no org_id: creates default portal company + membership", async () => {
    const { db, state } = createFakeDb();
    const app = createApp(db);
    const token = makePortalJwt({ email: "fresh@example.com" });

    const res = await request(app).get("/cortex/auth/callback").query({ token });

    expect(res.status).toBe(302);
    expect(state.userInsertCount).toBe(1);
    expect(state.companyInsertCount).toBe(1);
    expect(state.companies[0]).toEqual({
      id: DEFAULT_PORTAL_COMPANY_ID,
      name: "WBIT Portal Users",
    });
    expect(state.membershipInsertCount).toBe(1);
    expect(state.memberships[0]).toMatchObject({
      companyId: DEFAULT_PORTAL_COMPANY_ID,
      principalType: "user",
      principalId: state.users[0].id,
      status: "active",
      membershipRole: "operator",
    });
  });

  it("new user, default company already exists: no duplicate company, membership created", async () => {
    const { db, state } = createFakeDb({
      companies: [{ id: DEFAULT_PORTAL_COMPANY_ID, name: "WBIT Portal Users" }],
    });
    const app = createApp(db);
    const token = makePortalJwt({ email: "second@example.com" });

    const res = await request(app).get("/cortex/auth/callback").query({ token });

    expect(res.status).toBe(302);
    expect(state.companyInsertCount).toBe(0);
    expect(state.companies).toHaveLength(1);
    expect(state.userInsertCount).toBe(1);
    expect(state.membershipInsertCount).toBe(1);
    expect(state.memberships[0].principalId).toBe(state.users[0].id);
  });

  it("existing user without membership: no duplicate user, membership created", async () => {
    const { db, state } = createFakeDb({
      users: [{ id: "user-x", email: "no-membership@example.com", name: "X" }],
      companies: [{ id: DEFAULT_PORTAL_COMPANY_ID, name: "WBIT Portal Users" }],
    });
    const app = createApp(db);
    const token = makePortalJwt({ email: "no-membership@example.com" });

    const res = await request(app).get("/cortex/auth/callback").query({ token });

    expect(res.status).toBe(302);
    expect(state.userInsertCount).toBe(0);
    expect(state.companyInsertCount).toBe(0);
    expect(state.membershipInsertCount).toBe(1);
    expect(state.memberships[0].principalId).toBe("user-x");
  });

  it("existing user with existing membership: idempotent (no duplicate membership)", async () => {
    const { db, state } = createFakeDb({
      users: [{ id: "user-y", email: "already-in@example.com", name: "Y" }],
      companies: [{ id: DEFAULT_PORTAL_COMPANY_ID, name: "WBIT Portal Users" }],
      memberships: [
        {
          id: "mem-existing",
          companyId: DEFAULT_PORTAL_COMPANY_ID,
          principalType: "user",
          principalId: "user-y",
          status: "active",
          membershipRole: "operator",
        },
      ],
    });
    const app = createApp(db);
    const token = makePortalJwt({ email: "already-in@example.com" });

    const res = await request(app).get("/cortex/auth/callback").query({ token });

    expect(res.status).toBe(302);
    expect(state.userInsertCount).toBe(0);
    expect(state.companyInsertCount).toBe(0);
    expect(state.membershipInsertCount).toBe(0);
    expect(state.memberships).toHaveLength(1);
  });

  it("same email, two different org_id claims: two memberships, two companies", async () => {
    const { db, state } = createFakeDb();
    const app = createApp(db);
    const orgA = "11111111-1111-4111-a111-111111111111";
    const orgB = "22222222-2222-4222-a222-222222222222";

    const resA = await request(app)
      .get("/cortex/auth/callback")
      .query({ token: makePortalJwt({ email: "multi@example.com", org_id: orgA, org_name: "Org A" }) });
    expect(resA.status).toBe(302);

    const resB = await request(app)
      .get("/cortex/auth/callback")
      .query({ token: makePortalJwt({ email: "multi@example.com", org_id: orgB, org_name: "Org B" }) });
    expect(resB.status).toBe(302);

    expect(state.userInsertCount).toBe(1);
    expect(state.companies.map((c) => c.id).sort()).toEqual([orgA, orgB].sort());
    expect(state.companies.find((c) => c.id === orgA)?.name).toBe("Org A");
    expect(state.companies.find((c) => c.id === orgB)?.name).toBe("Org B");
    expect(state.memberships).toHaveLength(2);
    const principalIds = new Set(state.memberships.map((m) => m.principalId));
    expect(principalIds.size).toBe(1);
    const companyIds = state.memberships.map((m) => m.companyId).sort();
    expect(companyIds).toEqual([orgA, orgB].sort());
  });

  it("ignores non-UUID org_id and falls back to default company", async () => {
    const { db, state } = createFakeDb();
    const app = createApp(db);
    const token = makePortalJwt({ email: "bogus-org@example.com", org_id: "not-a-uuid" });

    const res = await request(app).get("/cortex/auth/callback").query({ token });

    expect(res.status).toBe(302);
    expect(state.companies).toHaveLength(1);
    expect(state.companies[0].id).toBe(DEFAULT_PORTAL_COMPANY_ID);
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
