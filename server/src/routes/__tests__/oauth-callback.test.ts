import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { oauthCallbackRoute } from "../oauth-callback.js";

// Helpers: the route now does an atomic claim
//   db.update(states).set({consumedAt}).where(id AND consumed_at IS NULL AND
//   expires_at > now()).returning()
// followed by (only on claim failure) a SELECT to disambiguate the error.
// `claimed` is the array the .returning() resolves to: [stateRow] on success,
// [] on failure. `probe` is what findFirst returns to disambiguate.
function buildDbMock(opts: {
  claimed: unknown[];
  probe?: unknown;
}) {
  const findFirst = vi.fn().mockResolvedValue(opts.probe ?? null);
  const returning = vi.fn().mockResolvedValue(opts.claimed);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  const update = vi.fn().mockReturnValue({ set });
  return {
    update,
    query: { oauthAuthorizationStates: { findFirst } },
  };
}

describe("GET /api/oauth/callback/:providerId", () => {
  it("redirects to safe default with invalid_state when state row missing", async () => {
    const db = buildDbMock({ claimed: [], probe: null });
    const app = express();
    app.use(
      "/api/oauth/callback/:providerId",
      oauthCallbackRoute({
        db: db as unknown as never,
        registry: { get: () => undefined } as unknown as never,
        publicUrl: "https://app.paperclip.test",
        secretService: {
          upsertSecretByName: async () => ({ id: "s" }),
        },
      }),
    );
    const res = await request(app).get(
      "/api/oauth/callback/github?state=missing&code=x",
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("oauth_error=invalid_state");
  });

  it("redirects with replay error when consumed_at set", async () => {
    // Atomic claim returns [] because consumed_at IS NULL fails. The probe
    // SELECT returns the row with a non-null consumedAt → disambiguate to
    // replay.
    const db = buildDbMock({
      claimed: [],
      probe: {
        id: "s",
        providerId: "github",
        consumedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        returnUrl: "/settings/connections",
        companyId: "c1",
        codeVerifier: "v",
        redirectUri: "x",
        scopesRequested: [],
      },
    });
    const app = express();
    app.use(
      "/api/oauth/callback/:providerId",
      oauthCallbackRoute({
        db: db as unknown as never,
        registry: {
          get: () => ({ config: { id: "github" } } as unknown as never),
        } as unknown as never,
        publicUrl: "https://app.paperclip.test",
        secretService: {
          upsertSecretByName: async () => ({ id: "s" }),
        },
      }),
    );
    const res = await request(app).get(
      "/api/oauth/callback/github?state=s&code=x",
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("oauth_error=replay");
  });

  it("redirects with invalid_state when expires_at predicate fails", async () => {
    // Atomic claim returns [] because expires_at > now() fails. The probe
    // SELECT returns a row with no consumedAt → disambiguate to expired
    // (rendered as invalid_state for users).
    const db = buildDbMock({
      claimed: [],
      probe: {
        id: "s",
        providerId: "github",
        consumedAt: null,
        expiresAt: new Date(Date.now() - 60_000),
        returnUrl: "/settings/connections",
        companyId: "c1",
        codeVerifier: "v",
        redirectUri: "x",
        scopesRequested: [],
      },
    });
    const app = express();
    app.use(
      "/api/oauth/callback/:providerId",
      oauthCallbackRoute({
        db: db as unknown as never,
        registry: { get: () => undefined } as unknown as never,
        publicUrl: "https://app.paperclip.test",
        secretService: {
          upsertSecretByName: async () => ({ id: "s" }),
        },
      }),
    );
    const res = await request(app).get(
      "/api/oauth/callback/github?state=s&code=x",
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("oauth_error=invalid_state");
  });

  it("does not call findFirst on the happy path — claim returns the row directly", async () => {
    // Atomic claim succeeds and returns the stateRow via RETURNING. There
    // should be NO follow-up SELECT in this path. We then hit
    // provider_mismatch because the registry says the provider is unknown
    // (returns undefined → provider_not_found instead — let us route to
    // provider_mismatch by giving a mismatched providerId on the row).
    const db = buildDbMock({
      claimed: [
        {
          id: "s",
          providerId: "slack", // mismatch with the URL providerId "github"
          consumedAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
          returnUrl: "/settings/connections",
          companyId: "c1",
          codeVerifier: "v",
          redirectUri: "x",
          scopesRequested: [],
        },
      ],
    });
    const app = express();
    app.use(
      "/api/oauth/callback/:providerId",
      oauthCallbackRoute({
        db: db as unknown as never,
        registry: { get: () => undefined } as unknown as never,
        publicUrl: "https://app.paperclip.test",
        secretService: {
          upsertSecretByName: async () => ({ id: "s" }),
        },
      }),
    );
    const res = await request(app).get(
      "/api/oauth/callback/github?state=s&code=x",
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("oauth_error=provider_mismatch");
    expect(db.query.oauthAuthorizationStates.findFirst).not.toHaveBeenCalled();
  });
});
