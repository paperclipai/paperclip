import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { oauthRoutes } from "../oauth.js";
import { ProviderRegistry } from "../../oauth/registry.js";

const conn = {
  id: "conn-1",
  companyId: "c1",
  providerId: "github",
  status: "active",
  accountId: "42",
  accountLabel: "octocat",
  scopes: ["repo"],
  accessTokenSecretId: "s1",
  refreshTokenSecretId: null,
  accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
  lastRefreshedAt: new Date(),
  lastError: null,
  lastErrorAt: null,
  refreshAttemptCount: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeApp(rows: Array<typeof conn>) {
  const env = { GH_ID: "id", GH_SECRET: "s" };
  const registry = new ProviderRegistry({ env });
  registry.register(
    {
      id: "github",
      displayName: "GitHub",
      clientCredentials: { clientIdEnv: "GH_ID", clientSecretEnv: "GH_SECRET" },
      endpoints: {
        authorize: "https://x.example/a",
        token: "https://x.example/t",
        accountInfo: "https://x.example/me",
      },
      scopes: { default: [], offered: [] },
      pkce: "required",
      authMethod: "post",
      responseFormat: "json",
      accountIdField: "id",
      accountLabelField: "login",
      refresh: { supported: false },
    },
    "yaml",
  );
  const db = {
    query: {
      oauthConnections: {
        findMany: vi.fn().mockResolvedValue(rows),
        findFirst: vi.fn().mockResolvedValue(rows[0] ?? null),
      },
    },
  };
  const app = express();
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
    }),
  );
  return app;
}

describe("Connection management routes", () => {
  it("GET /connections returns no token material", async () => {
    const res = await request(makeApp([conn])).get("/api/companies/c1/oauth/connections");
    expect(res.status).toBe(200);
    expect(res.body.connections).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain("accessTokenSecretId");
    expect(JSON.stringify(res.body)).not.toContain("refreshTokenSecretId");
  });

  it("GET /connections/:id returns 404 for missing", async () => {
    const res = await request(makeApp([])).get("/api/companies/c1/oauth/connections/missing");
    expect(res.status).toBe(404);
  });

  it("GET /connections/:id rejects cross-tenant", async () => {
    const otherTenantConn = { ...conn, companyId: "c2" };
    const res = await request(makeApp([otherTenantConn])).get(
      "/api/companies/c1/oauth/connections/conn-1",
    );
    expect(res.status).toBe(404);
  });
});
