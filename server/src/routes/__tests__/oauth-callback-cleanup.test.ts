import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { oauthCallbackRoute } from "../oauth-callback.js";

vi.mock("../../oauth/http.js", () => ({
  exchangeToken: vi.fn().mockResolvedValue({}),
  fetchAccountInfo: vi.fn().mockResolvedValue({}),
}));

describe("OAuth callback cleanup", () => {
  const provider = {
    config: {
      id: "github",
      endpoints: {
        token: "https://github.example/token",
        accountInfo: "https://github.example/me",
      },
      authMethod: "post",
      responseFormat: "json",
    },
    clientId: "client",
    clientSecret: "secret",
    shape: {
      parseTokenResponse: () => ({
        accessToken: "ACCESS",
        refreshToken: "REFRESH",
        expiresInSeconds: 3600,
        scope: ["repo"],
      }),
      parseAccountInfo: () => ({
        accountId: "acct-1",
        accountLabel: "octocat",
      }),
    },
  };

  it("removes newly written token secrets when the connection transaction fails", async () => {
    const stateRow = {
      id: "state-1",
      providerId: "github",
      consumedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      returnUrl: "/settings/connections",
      companyId: "c1",
      codeVerifier: "verifier",
      redirectUri: "https://app.paperclip.test/api/oauth/callback/github",
      scopesRequested: ["repo"],
    };

    const returning = vi.fn().mockResolvedValue([stateRow]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set });
    const tx = {
      query: {
        oauthConnections: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      },
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockRejectedValue(new Error("db_down")),
      }),
    };
    const db = {
      update,
      query: {
        oauthAuthorizationStates: {
          findFirst: vi.fn(),
        },
        oauthConnections: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      },
      transaction: vi.fn(async (fn: (transaction: typeof tx) => Promise<void>) =>
        fn(tx),
      ),
    };
    const remove = vi.fn().mockResolvedValue(undefined);

    const app = express();
    app.use(
      "/api/oauth/callback/:providerId",
      oauthCallbackRoute({
        db: db as unknown as never,
        registry: {
          get: () => provider,
        } as unknown as never,
        publicUrl: "https://app.paperclip.test",
        secretService: {
          upsertSecretByName: vi
            .fn()
            .mockResolvedValueOnce({ id: "access-secret" })
            .mockResolvedValueOnce({ id: "refresh-secret" }),
          remove,
        },
      }),
    );
    app.use(
      (
        _err: unknown,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        res.status(500).json({ errorCode: "internal_error" });
      },
    );

    const res = await request(app).get(
      "/api/oauth/callback/github?state=state-1&code=code",
    );

    expect(res.status).toBe(500);
    expect(remove).toHaveBeenCalledWith("access-secret");
    expect(remove).toHaveBeenCalledWith("refresh-secret");
  });

  it("redirects and rolls back partial writes when refresh secret persistence fails", async () => {
    const stateRow = {
      id: "state-1",
      providerId: "github",
      consumedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      returnUrl: "/settings/connections",
      companyId: "c1",
      codeVerifier: "verifier",
      redirectUri: "https://app.paperclip.test/api/oauth/callback/github",
      scopesRequested: ["repo"],
    };
    const returning = vi.fn().mockResolvedValue([stateRow]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set });
    const db = {
      update,
      query: {
        oauthAuthorizationStates: { findFirst: vi.fn() },
        oauthConnections: { findFirst: vi.fn().mockResolvedValue(null) },
      },
      transaction: vi.fn(),
    };
    const remove = vi.fn().mockResolvedValue(undefined);

    const app = express();
    app.use(
      "/api/oauth/callback/:providerId",
      oauthCallbackRoute({
        db: db as unknown as never,
        registry: { get: () => provider } as unknown as never,
        publicUrl: "https://app.paperclip.test",
        secretService: {
          upsertSecretByName: vi
            .fn()
            .mockResolvedValueOnce({ id: "access-secret" })
            .mockRejectedValueOnce(new Error("encrypt_down")),
          remove,
        },
      }),
    );

    const res = await request(app).get(
      "/api/oauth/callback/github?state=state-1&code=code",
    );

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain(
      "oauth_error=token_persistence_failed",
    );
    expect(remove).toHaveBeenCalledWith("access-secret");
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
