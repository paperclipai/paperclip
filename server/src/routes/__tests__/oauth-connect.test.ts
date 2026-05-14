import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { oauthRoutes } from "../oauth.js";
import { ProviderRegistry } from "../../oauth/registry.js";

function setup(opts: {
  rateLimiter?: { check: ReturnType<typeof vi.fn> };
  connectFloodLimiter?: { check: ReturnType<typeof vi.fn> };
} = {}) {
  const insertMock = vi.fn().mockResolvedValue([{ id: "state-uuid-123" }]);
  const db = {
    insert: () => ({ values: () => ({ returning: insertMock }) }),
  };
  const env = { GH_ID: "id", GH_SECRET: "s" };
  const registry = new ProviderRegistry({ env });
  registry.register(
    {
      id: "github",
      displayName: "GitHub",
      clientCredentials: { clientIdEnv: "GH_ID", clientSecretEnv: "GH_SECRET" },
      endpoints: {
        authorize: "https://github.com/login/oauth/authorize",
        token: "https://x.example/t",
        accountInfo: "https://x.example/me",
      },
      scopes: { default: ["repo"], offered: ["repo", "workflow"] },
      pkce: "required",
      authMethod: "post",
      responseFormat: "json",
      accountIdField: "id",
      accountLabelField: "login",
      refresh: { supported: false },
    },
    "yaml",
  );
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
        rateLimiter: opts.rateLimiter ?? { check: vi.fn(async () => true) },
        connectFloodLimiter: opts.connectFloodLimiter,
        secretService: {},
      }),
  );
  return { app, insertMock };
}

describe("POST /connect/:providerId", () => {
  it("returns authorize URL with PKCE challenge + state", async () => {
    const { app } = setup();
    const res = await request(app)
      .post("/api/companies/c1/oauth/connect/github")
      .send({ returnUrl: "/settings/connections" });
    expect(res.status).toBe(200);
    const url = new URL(res.body.authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.paperclip.test/api/oauth/callback/github",
    );
    expect(url.searchParams.get("scope")).toBe("repo");
    expect(url.searchParams.get("state")).toBe("state-uuid-123");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
  });

  it("rejects scopes not in offered", async () => {
    const { app } = setup();
    const res = await request(app)
      .post("/api/companies/c1/oauth/connect/github")
      .send({ scopes: ["admin:everything"] });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe("invalid_scope");
  });

  it("checks company flood limit before consuming a per-user rate-limit slot", async () => {
    const rateLimiter = { check: vi.fn(async () => true) };
    const connectFloodLimiter = { check: vi.fn(async () => false) };
    const { app } = setup({ rateLimiter, connectFloodLimiter });

    const res = await request(app).post("/api/companies/c1/oauth/connect/github");

    expect(res.status).toBe(429);
    expect(res.body.errorCode).toBe("connect_flood");
    expect(connectFloodLimiter.check).toHaveBeenCalledTimes(1);
    expect(rateLimiter.check).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown provider", async () => {
    const { app } = setup();
    const res = await request(app).post("/api/companies/c1/oauth/connect/unknown");
    expect(res.status).toBe(404);
  });

  it("returns 429 when rate limit exceeded", async () => {
    const insertMock = vi.fn().mockResolvedValue([{ id: "s" }]);
    const db = { insert: () => ({ values: () => ({ returning: insertMock }) }) };
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
        rateLimiter: { check: async () => false },
        secretService: {},
      }),
    );
    const res = await request(app).post("/api/companies/c1/oauth/connect/github");
    expect(res.status).toBe(429);
  });
});
