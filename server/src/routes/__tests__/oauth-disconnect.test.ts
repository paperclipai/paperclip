import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { oauthRoutes } from "../oauth.js";
import { ProviderRegistry } from "../../oauth/registry.js";

vi.mock("../../oauth/revoke.js", () => ({
  revokeUpstreamToken: vi.fn(),
}));

import { revokeUpstreamToken } from "../../oauth/revoke.js";

function makeApp({ revokeFails = false, membershipRole = "admin" }: { revokeFails?: boolean; membershipRole?: string } = {}) {
  vi.mocked(revokeUpstreamToken).mockReset();
  vi.mocked(revokeUpstreamToken).mockImplementation(() =>
    revokeFails ? Promise.reject(new Error("rev fail")) : Promise.resolve(),
  );

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
        revoke: "https://api.github.com/applications/{client_id}/grant",
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

  const conn = {
    id: "c",
    companyId: "c1",
    providerId: "github",
    accessTokenSecretId: "s1",
    refreshTokenSecretId: "s2",
    status: "active",
  };

  const tx = {
    delete: vi.fn().mockReturnValue({
      where: () => Promise.resolve(),
    }),
  };
  const db = {
    query: {
      oauthConnections: {
        findFirst: vi.fn().mockResolvedValue(conn),
      },
    },
    transaction: vi.fn().mockImplementation(async (fn: any) => fn(tx)),
  };

  const removeFn = vi.fn().mockResolvedValue(null);
  const resolveFn = vi
    .fn()
    .mockImplementation(async (_companyId: string, secretId: string) =>
      secretId === "s1" ? "access-token-value" : "refresh-token-value",
    );
  const getByIdFn = vi
    .fn()
    .mockImplementation(async (id: string) => ({ id, latestVersion: 1 }));

  const app = express();
  app.use(
    "/api/companies/:companyId/oauth",
    (req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = {
        type: "board",
        userId: "u1",
        memberships: [
          { companyId: req.params.companyId, membershipRole },
        ],
      };
      next();
    },
    oauthRoutes({
      registry,
      db: db as unknown as never,
      publicUrl: "https://app.paperclip.test",
      rateLimiter: { check: async () => true },
      secretService: {
        upsertSecretByName: vi.fn(),
        resolveSecretValue: resolveFn,
        remove: removeFn,
        getById: getByIdFn,
      },
    }),
  );
  return { app, db, removeFn, resolveFn, getByIdFn, tx };
}

describe("DELETE /connections/:id", () => {
  it("returns 204 on success and revokes upstream + removes secrets", async () => {
    const { app, removeFn, resolveFn } = makeApp();
    const res = await request(app).delete("/api/companies/c1/oauth/connections/c");
    expect(res.status).toBe(204);
    expect(vi.mocked(revokeUpstreamToken)).toHaveBeenCalledTimes(1);
    expect(resolveFn).toHaveBeenCalledTimes(2);
    expect(removeFn).toHaveBeenCalledWith("s1");
    expect(removeFn).toHaveBeenCalledWith("s2");
  });

  it("still returns 204 when upstream revoke fails", async () => {
    const { app } = makeApp({ revokeFails: true });
    const res = await request(app).delete("/api/companies/c1/oauth/connections/c");
    expect(res.status).toBe(204);
    expect(vi.mocked(revokeUpstreamToken)).toHaveBeenCalled();
  });

  it("returns 403 for a member without admin/owner role", async () => {
    const { app } = makeApp({ membershipRole: "member" });
    const res = await request(app).delete("/api/companies/c1/oauth/connections/c");
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errorCode: "forbidden" });
  });
});
