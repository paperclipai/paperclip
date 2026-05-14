import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { oauthRoutes } from "../oauth.js";
import { ProviderRegistry } from "../../oauth/registry.js";

interface MakeAppOptions {
  refreshOutcome?:
    | { outcome: "success"; accessToken: string }
    | { outcome: "revoked" }
    | { outcome: "transient"; error: string }
    | { outcome: "skipped"; reason: string };
  conn?: Record<string, unknown> | null;
  afterRefreshConn?: Record<string, unknown> | null;
}

function makeApp(opts: MakeAppOptions = {}) {
  const env = { GH_ID: "id", GH_SECRET: "s" };
  const registry = new ProviderRegistry({ env });
  registry.register(
    {
      id: "github",
      displayName: "GitHub",
      clientCredentials: { clientIdEnv: "GH_ID", clientSecretEnv: "GH_SECRET" },
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
      accountLabelField: "login",
      refresh: { supported: true, rotatesRefreshToken: false },
    },
    "yaml",
  );

  const conn =
    opts.conn === undefined
      ? {
          id: "conn",
          companyId: "c1",
          providerId: "github",
          status: "active",
          accountId: null,
          accountLabel: null,
          scopes: [],
          accessTokenExpiresAt: null,
          lastRefreshedAt: null,
          lastError: null,
          lastErrorAt: null,
          refreshAttemptCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        }
      : opts.conn;
  const findFirst = vi
    .fn()
    .mockResolvedValueOnce(conn)
    .mockResolvedValue(
      opts.afterRefreshConn === undefined ? conn : opts.afterRefreshConn,
    );
  const db = {
    query: {
      oauthConnections: { findFirst },
    },
  };
  const refreshFn = vi
    .fn()
    .mockResolvedValue(opts.refreshOutcome ?? { outcome: "transient", error: "boom" });

  const app = express();
  app.use(express.json());
  app.use(
    "/api/companies/:companyId/oauth",
    (req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = {
        type: "board",
        userId: "u1",
        memberships: [{ companyId: req.params.companyId, membershipRole: "admin" }],
      };
      next();
    },
    oauthRoutes({
      registry,
      db: db as unknown as never,
      publicUrl: "https://app.paperclip.test",
      rateLimiter: { check: async () => true },
      secretService: {},
      refreshFn,
    }),
  );
  return { app, refreshFn, findFirst };
}

describe("POST /connections/:id/refresh", () => {
  it("returns 200 on success", async () => {
    const { app, refreshFn } = makeApp({
      refreshOutcome: { outcome: "success", accessToken: "x" },
    });
    const res = await request(app).post(
      "/api/companies/c1/oauth/connections/conn/refresh",
    );
    expect(res.status).toBe(200);
    expect(refreshFn).toHaveBeenCalledTimes(1);
    expect(res.body.id).toBe("conn");
  });

  it("returns 429 when in backoff window", async () => {
    const { app, refreshFn } = makeApp({
      conn: {
        id: "conn",
        companyId: "c1",
        providerId: "github",
        status: "error",
        accountId: null,
        accountLabel: null,
        scopes: [],
        accessTokenExpiresAt: null,
        lastRefreshedAt: null,
        lastError: "boom",
        lastErrorAt: new Date(Date.now() - 1_000), // 1s ago, far inside backoff
        refreshAttemptCount: 3,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const res = await request(app).post(
      "/api/companies/c1/oauth/connections/conn/refresh",
    );
    expect(res.status).toBe(429);
    expect(res.body.errorCode).toBe("in_backoff");
    expect(res.headers["retry-after"]).toBeDefined();
    expect(refreshFn).not.toHaveBeenCalled();
  });

  it("returns 409 when refresh result is revoked", async () => {
    const { app } = makeApp({ refreshOutcome: { outcome: "revoked" } });
    const res = await request(app).post(
      "/api/companies/c1/oauth/connections/conn/refresh",
    );
    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe("connection_revoked");
  });

  it("returns 404 when connection is deleted after refresh completes", async () => {
    const { app, refreshFn } = makeApp({
      refreshOutcome: { outcome: "success", accessToken: "x" },
      afterRefreshConn: null,
    });
    const res = await request(app).post(
      "/api/companies/c1/oauth/connections/conn/refresh",
    );
    expect(res.status).toBe(404);
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it("returns 404 when connection does not belong to company", async () => {
    const { app } = makeApp({ conn: null });
    const res = await request(app).post(
      "/api/companies/c1/oauth/connections/conn/refresh",
    );
    expect(res.status).toBe(404);
  });
});
