import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import express from "express";
import request from "supertest";
import pino from "pino";
import { eq } from "drizzle-orm";
import { oauthConnections } from "@paperclipai/db";

import { validateReturnUrl } from "../../oauth/redirect-allowlist.js";
import { OAUTH_REDACT_PATHS } from "../../oauth/logger.js";
import { ProviderRegistry } from "../../oauth/registry.js";
import { oauthRoutes } from "../../routes/oauth.js";
import {
  createTestSecretService,
  oauthEmbeddedPostgresSupport,
  seedTestCompany,
  seedTestUser,
  setupOAuthTestEnv,
  type Db,
} from "./test-setup.js";

const PUBLIC = "https://app.paperclip.test";

// OWASP-style return-URL evasion vectors. All MUST collapse to the safe
// default per `validateReturnUrl`.
const OWASP_VECTORS = [
  "//evil.example/x",
  "\\\\evil.example/x",
  "https:%2F%2Fevil.example",
  "https:\\\\evil.example/x",
  "https://app.paperclip.test@evil.example/x",
  "https://evil.example/.app.paperclip.test/",
  "/\\evil.example/x",
];

// ---------------------------------------------------------------------------
// 1. Open-redirect regression vectors (plain unit assertions; no DB needed).
// ---------------------------------------------------------------------------
describe("Security: open-redirect regression vectors", () => {
  for (const v of OWASP_VECTORS) {
    it(`falls back to safe default for: ${JSON.stringify(v)}`, () => {
      expect(validateReturnUrl(v, PUBLIC)).toBe("/settings/connections");
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Token redaction.
//
// The production logger uses `pino.transport({ targets: [...] })`, which spawns
// a worker thread; writes from there don't pass through the main process's
// `process.stdout.write`, so we can't spy on it. We instead mirror the
// canonical pattern from `server/src/oauth/__tests__/logger.test.ts`: build a
// parallel pino instance with the exported `OAUTH_REDACT_PATHS` and route it
// to an in-memory `PassThrough`. This verifies the redact-path list itself.
// ---------------------------------------------------------------------------
describe("Security: token redaction", () => {
  it("OAUTH_REDACT_PATHS censors code_verifier alongside other token-shaped fields", async () => {
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on("data", (c) => chunks.push(c));
    const parent = pino({ level: "info" }, stream);
    const child = parent.child(
      { component: "oauth" },
      { redact: { paths: OAUTH_REDACT_PATHS, censor: "[REDACTED]" } },
    );

    child.info(
      {
        access_token: "ACCESS_X",
        refresh_token: "REFRESH_X",
        code_verifier: "VERIFIER_X",
        client_secret: "CLIENT_SECRET_X",
      },
      "test event",
    );
    await new Promise((r) => setImmediate(r));
    const all = Buffer.concat(chunks).toString("utf8");
    expect(all).not.toContain("ACCESS_X");
    expect(all).not.toContain("REFRESH_X");
    expect(all).not.toContain("VERIFIER_X");
    expect(all).not.toContain("CLIENT_SECRET_X");
    expect(all).toContain("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// 3. Cross-tenant isolation. Uses the embedded-postgres harness already
//    established by `integration.test.ts`. Skipped automatically on hosts
//    where embedded-postgres can't migrate (mirrors integration.test).
// ---------------------------------------------------------------------------
const describeEmbeddedPostgres = oauthEmbeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!oauthEmbeddedPostgresSupport.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping OAuth cross-tenant security tests: ${oauthEmbeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("Security: cross-tenant isolation", () => {
  let env!: Awaited<ReturnType<typeof setupOAuthTestEnv>>;
  let db!: Db;

  beforeAll(async () => {
    env = await setupOAuthTestEnv("oauth-security");
    db = env.db;
  }, 60_000);

  afterAll(async () => {
    await env.cleanup();
  });

  afterEach(async () => {
    await env.reset();
  });

  function buildApp(opts: {
    actorCompanyId: string;
    userId: string;
  }): express.Express {
    const baseEnv: Record<string, string | undefined> = {
      MOCK_OAUTH_CLIENT_ID: "client-id",
      MOCK_OAUTH_CLIENT_SECRET: "client-secret",
    };
    const registry = new ProviderRegistry({ env: baseEnv });
    registry.register(
      {
        id: "mock",
        displayName: "Mock",
        clientCredentials: {
          clientIdEnv: "MOCK_OAUTH_CLIENT_ID",
          clientSecretEnv: "MOCK_OAUTH_CLIENT_SECRET",
        },
        endpoints: {
          authorize: "https://x/a",
          token: "https://x/t",
          accountInfo: "https://x/me",
        },
        scopes: { default: [], offered: [] },
        pkce: "required",
        authMethod: "post",
        responseFormat: "json",
        accountIdField: "id",
        accountLabelField: "name",
        refresh: { supported: false },
      },
      "yaml",
    );
    const secretSvc = createTestSecretService(db, registry);
    const app = express();
    app.use(express.json());
    app.use(
      "/api/companies/:companyId/oauth",
      (req, _res, next) => {
        // Actor is admin of `actorCompanyId` only — even though the URL says
        // `:companyId`, `ensureMember` checks membership against that param.
        // We use `actorCompanyId` so the second test (where the URL points at
        // a *different* company) gets rejected at `ensureMember` rather than
        // exercising the cross-tenant query path. To exercise cross-tenant
        // *connection lookup* the actor must be admin of the URL's
        // `:companyId` (company A) — see the connections-by-id test below.
        (req as any).actor = {
          type: "board",
          userId: opts.userId,
          memberships: [
            { companyId: opts.actorCompanyId, membershipRole: "admin" },
          ],
        };
        next();
      },
      oauthRoutes({
        registry,
        db,
        publicUrl: "http://localhost",
        rateLimiter: { check: async () => true },
        secretService: secretSvc as any,
      }),
    );
    return app;
  }

  it("company A cannot fetch company B's connection by id (404, not 403)", async () => {
    const userId = await seedTestUser(db);
    const companyA = await seedTestCompany(db, { name: "A" });
    const companyB = await seedTestCompany(db, { name: "B" });

    // Seed a connection for company B (the secretService gives us a real
    // companySecrets row to satisfy the FK).
    const baseEnv: Record<string, string | undefined> = {
      MOCK_OAUTH_CLIENT_ID: "client-id",
      MOCK_OAUTH_CLIENT_SECRET: "client-secret",
    };
    const seedRegistry = new ProviderRegistry({ env: baseEnv });
    const seedSvc = createTestSecretService(db, seedRegistry);
    const accessSecret = await seedSvc.upsertSecretByName(companyB, {
      name: "oauth:mock:user-b:access",
      value: "stale-access",
    });
    const inserted = await db
      .insert(oauthConnections)
      .values({
        companyId: companyB,
        providerId: "mock",
        status: "active",
        accountId: "user-b",
        accountLabel: "B User",
        scopes: ["read"],
        accessTokenSecretId: accessSecret.id,
        accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      })
      .returning();
    expect(inserted).toHaveLength(1);
    const connBId = inserted[0]!.id;

    // Actor is admin of company A only and asks A's URL for B's connection id.
    const app = buildApp({ actorCompanyId: companyA, userId });
    const res = await request(app).get(
      `/api/companies/${companyA}/oauth/connections/${connBId}`,
    );
    // Spec §9.8: cross-tenant misses are 404, not 403 — to avoid leaking
    // existence.
    expect(res.status).toBe(404);

    // Sanity: B's connection still exists in the DB; it just isn't visible
    // through company A's URL space.
    const stillThere = await db
      .select()
      .from(oauthConnections)
      .where(eq(oauthConnections.id, connBId));
    expect(stillThere).toHaveLength(1);
  });

  it("GET /connections returns only the requested company's rows", async () => {
    const userId = await seedTestUser(db);
    const companyA = await seedTestCompany(db, { name: "A" });
    const companyB = await seedTestCompany(db, { name: "B" });

    // Seed one connection per tenant.
    const baseEnv: Record<string, string | undefined> = {
      MOCK_OAUTH_CLIENT_ID: "client-id",
      MOCK_OAUTH_CLIENT_SECRET: "client-secret",
    };
    const seedRegistry = new ProviderRegistry({ env: baseEnv });
    const seedSvc = createTestSecretService(db, seedRegistry);
    const accessA = await seedSvc.upsertSecretByName(companyA, {
      name: "oauth:mock:user-a:access",
      value: "a-access",
    });
    const accessB = await seedSvc.upsertSecretByName(companyB, {
      name: "oauth:mock:user-b:access",
      value: "b-access",
    });
    await db.insert(oauthConnections).values([
      {
        companyId: companyA,
        providerId: "mock",
        status: "active",
        accountId: "user-a",
        accountLabel: "A User",
        scopes: ["read"],
        accessTokenSecretId: accessA.id,
        accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
      {
        companyId: companyB,
        providerId: "mock",
        status: "active",
        accountId: "user-b",
        accountLabel: "B User",
        scopes: ["read"],
        accessTokenSecretId: accessB.id,
        accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    ]);

    const app = buildApp({ actorCompanyId: companyA, userId });
    const res = await request(app).get(
      `/api/companies/${companyA}/oauth/connections`,
    );
    expect(res.status).toBe(200);
    const conns = res.body.connections as Array<{
      accountId: string | null;
      providerId: string;
    }>;
    expect(conns).toHaveLength(1);
    expect(conns[0]!.accountId).toBe("user-a");
    // Token material must not leak in the listing — already covered in
    // oauth-connections.test, but worth a defence-in-depth assertion here.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("accessTokenSecretId");
    expect(body).not.toContain("refreshTokenSecretId");
  });
});

// ---------------------------------------------------------------------------
// 4. Scope escalation rejected. Plain-mock pattern shared with
//    `oauth-connect.test.ts` — no DB harness needed.
// ---------------------------------------------------------------------------
describe("Security: scope escalation rejected", () => {
  it("returns 400 + invalid_scope when a requested scope is not in `offered`", async () => {
    const env = { MOCK_OAUTH_CLIENT_ID: "id", MOCK_OAUTH_CLIENT_SECRET: "s" };
    const registry = new ProviderRegistry({ env });
    registry.register(
      {
        id: "mock",
        displayName: "Mock",
        clientCredentials: {
          clientIdEnv: "MOCK_OAUTH_CLIENT_ID",
          clientSecretEnv: "MOCK_OAUTH_CLIENT_SECRET",
        },
        endpoints: {
          authorize: "https://x/a",
          token: "https://x/t",
          accountInfo: "https://x/me",
        },
        // Intentionally narrow: only `read` is offered.
        scopes: { default: ["read"], offered: ["read"] },
        pkce: "required",
        authMethod: "post",
        responseFormat: "json",
        accountIdField: "id",
        accountLabelField: "name",
        refresh: { supported: false },
      },
      "yaml",
    );
    const insertMock = vi.fn().mockResolvedValue([{ id: "state-1" }]);
    const db = {
      insert: () => ({ values: () => ({ returning: insertMock }) }),
    };
    const app = express();
    app.use(express.json());
    app.use(
      "/api/companies/:companyId/oauth",
      (req, _res, next) => {
        (req as any).actor = {
          type: "board",
          userId: "u1",
          memberships: [{ companyId: req.params.companyId, membershipRole: "admin" }],
        };
        next();
      },
      oauthRoutes({
        registry,
        db: db as any,
        publicUrl: "http://x",
        rateLimiter: { check: async () => true },
        secretService: {} as any,
      }),
    );

    const res = await request(app)
      .post("/api/companies/c1/oauth/connect/mock")
      .send({ scopes: ["admin:everything"] });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe("invalid_scope");
    // The state row must NOT have been written when scope validation fails.
    expect(insertMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. State-row flooding. Drives 51 connect requests against a fake
//    per-company `connectFloodLimiter` that allows the first 50 and rejects
//    the 51st. Asserts the route returns 429 + `errorCode: "connect_flood"`.
// ---------------------------------------------------------------------------
describe("Security: state-row flooding", () => {
  it("returns 429 + connect_flood after the per-company limit is exceeded", async () => {
    const env = { MOCK_OAUTH_CLIENT_ID: "id", MOCK_OAUTH_CLIENT_SECRET: "s" };
    const registry = new ProviderRegistry({ env });
    registry.register(
      {
        id: "mock",
        displayName: "Mock",
        clientCredentials: {
          clientIdEnv: "MOCK_OAUTH_CLIENT_ID",
          clientSecretEnv: "MOCK_OAUTH_CLIENT_SECRET",
        },
        endpoints: {
          authorize: "https://x/a",
          token: "https://x/t",
          accountInfo: "https://x/me",
        },
        scopes: { default: [], offered: [] },
        pkce: "required",
        authMethod: "post",
        responseFormat: "json",
        accountIdField: "id",
        accountLabelField: "name",
        refresh: { supported: false },
      },
      "yaml",
    );

    let insertCount = 0;
    const insertMock = vi.fn().mockImplementation(async () => {
      insertCount++;
      return [{ id: `state-${insertCount}` }];
    });
    const db = {
      insert: () => ({ values: () => ({ returning: insertMock }) }),
    };

    // Per-user limiter is generously open so we can exercise the flood guard
    // independently. The flood limiter mimics a sliding-window with limit=50.
    let floodCallCount = 0;
    const connectFloodLimiter = {
      check: async (key: string) => {
        // Sanity-check the key shape since the test's whole point is per-
        // company isolation: it must include the URL's companyId.
        expect(key).toBe("connect-flood:c1");
        floodCallCount++;
        return floodCallCount <= 50;
      },
    };

    const app = express();
    app.use(express.json());
    app.use(
      "/api/companies/:companyId/oauth",
      (req, _res, next) => {
        (req as any).actor = {
          type: "board",
          userId: "u1",
          memberships: [{ companyId: req.params.companyId, membershipRole: "admin" }],
        };
        next();
      },
      oauthRoutes({
        registry,
        db: db as any,
        publicUrl: "http://x",
        rateLimiter: { check: async () => true },
        connectFloodLimiter,
        secretService: {} as any,
      }),
    );

    // Drive the first 50 — all should succeed.
    for (let i = 0; i < 50; i++) {
      const res = await request(app).post("/api/companies/c1/oauth/connect/mock");
      expect(res.status).toBe(200);
    }
    expect(floodCallCount).toBe(50);
    expect(insertCount).toBe(50);

    // 51st call: flood limiter rejects, we get 429 + connect_flood, and the
    // state row is NOT written.
    const flooded = await request(app).post(
      "/api/companies/c1/oauth/connect/mock",
    );
    expect(flooded.status).toBe(429);
    expect(flooded.body.errorCode).toBe("connect_flood");
    expect(floodCallCount).toBe(51);
    expect(insertCount).toBe(50);
  });

  it("does not check the flood limiter when it isn't supplied (back-compat)", async () => {
    const env = { MOCK_OAUTH_CLIENT_ID: "id", MOCK_OAUTH_CLIENT_SECRET: "s" };
    const registry = new ProviderRegistry({ env });
    registry.register(
      {
        id: "mock",
        displayName: "Mock",
        clientCredentials: {
          clientIdEnv: "MOCK_OAUTH_CLIENT_ID",
          clientSecretEnv: "MOCK_OAUTH_CLIENT_SECRET",
        },
        endpoints: {
          authorize: "https://x/a",
          token: "https://x/t",
          accountInfo: "https://x/me",
        },
        scopes: { default: [], offered: [] },
        pkce: "required",
        authMethod: "post",
        responseFormat: "json",
        accountIdField: "id",
        accountLabelField: "name",
        refresh: { supported: false },
      },
      "yaml",
    );
    const insertMock = vi.fn().mockResolvedValue([{ id: "s1" }]);
    const db = {
      insert: () => ({ values: () => ({ returning: insertMock }) }),
    };
    const app = express();
    app.use(express.json());
    app.use(
      "/api/companies/:companyId/oauth",
      (req, _res, next) => {
        (req as any).actor = {
          type: "board",
          userId: "u1",
          memberships: [{ companyId: req.params.companyId, membershipRole: "admin" }],
        };
        next();
      },
      oauthRoutes({
        registry,
        db: db as any,
        publicUrl: "http://x",
        rateLimiter: { check: async () => true },
        secretService: {} as any,
      }),
    );
    const res = await request(app).post("/api/companies/c1/oauth/connect/mock");
    expect(res.status).toBe(200);
  });
});
