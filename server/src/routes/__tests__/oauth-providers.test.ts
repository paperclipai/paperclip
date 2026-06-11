import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { oauthRoutes } from "../oauth.js";
import { ProviderRegistry } from "../../oauth/registry.js";

function makeApp() {
  const env = { GH_ID: "id", GH_SECRET: "s" };
  const registry = new ProviderRegistry({ env });
  registry.register(
    {
      id: "github",
      displayName: "GitHub",
      iconUrl: "https://example.com/icon.png",
      docUrl: "https://example.com/docs",
      clientCredentials: { clientIdEnv: "GH_ID", clientSecretEnv: "GH_SECRET" },
      endpoints: {
        authorize: "https://x.example/a",
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
    oauthRoutes({ registry } as unknown as Parameters<typeof oauthRoutes>[0]),
  );
  return app;
}

describe("GET /providers", () => {
  it("returns provider summaries (no client secrets)", async () => {
    const res = await request(makeApp()).get("/api/companies/c1/oauth/providers");
    expect(res.status).toBe(200);
    expect(res.body.providers).toHaveLength(1);
    expect(res.body.providers[0]).toMatchObject({ id: "github", displayName: "GitHub" });
    expect(JSON.stringify(res.body)).not.toContain("clientSecret");
  });

  it("GET /providers/:id returns single", async () => {
    const res = await request(makeApp()).get("/api/companies/c1/oauth/providers/github");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("github");
  });

  it("404 for unknown provider", async () => {
    const res = await request(makeApp()).get("/api/companies/c1/oauth/providers/unknown");
    expect(res.status).toBe(404);
  });
});
