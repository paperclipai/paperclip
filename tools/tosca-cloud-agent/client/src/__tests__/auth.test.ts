import { afterEach, describe, expect, it } from "vitest";
import { clearSSOTokenCache, resolveAuth, resolvePatAuth } from "../auth.js";
import { ToscaAuthError } from "../types.js";
import {
  mockJsonResponse,
  mockSequentialJsonResponses,
} from "./helpers.js";
import ssoTokenFixture from "../../fixtures/sso-token.json" with { type: "json" };

describe("resolvePatAuth", () => {
  it("returns Bearer header from PAT token", () => {
    const auth = resolvePatAuth({ type: "pat", token: "my-secret-pat" });
    expect(auth.authorizationHeader).toBe("Bearer my-secret-pat");
  });
});

describe("resolveAuth — PAT", () => {
  it("resolves PAT credentials without calling fetch", async () => {
    const fetch = mockJsonResponse({});
    const auth = await resolveAuth({ type: "pat", token: "tok-123" }, fetch);
    expect(auth.authorizationHeader).toBe("Bearer tok-123");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("resolveAuth — SSO", () => {
  afterEach(() => {
    clearSSOTokenCache();
  });

  it("fetches an OAuth2 client_credentials token", async () => {
    const fetch = mockJsonResponse(ssoTokenFixture);
    const auth = await resolveAuth(
      {
        type: "sso",
        tenantUrl: "https://myorg.tricentis.com",
        clientId: "client-abc",
        clientSecret: "secret-xyz",
      },
      fetch,
    );

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://myorg.tricentis.com/oauth/token");
    expect(init.method).toBe("POST");
    expect(auth.authorizationHeader).toBe(
      `Bearer ${ssoTokenFixture.access_token}`,
    );
  });

  it("caches the SSO token for subsequent calls", async () => {
    const fetch = mockSequentialJsonResponses([
      { body: ssoTokenFixture },
      { body: ssoTokenFixture },
    ]);
    const creds = {
      type: "sso" as const,
      tenantUrl: "https://myorg.tricentis.com",
      clientId: "client-abc",
      clientSecret: "secret-xyz",
    };
    await resolveAuth(creds, fetch);
    await resolveAuth(creds, fetch);

    expect(fetch).toHaveBeenCalledOnce();
  });

  it("throws ToscaAuthError when the token endpoint returns non-OK", async () => {
    const fetch = mockJsonResponse({ error: "invalid_client" }, 401);
    await expect(
      resolveAuth(
        {
          type: "sso",
          tenantUrl: "https://myorg.tricentis.com",
          clientId: "bad-client",
          clientSecret: "bad-secret",
        },
        fetch,
      ),
    ).rejects.toThrow(ToscaAuthError);
  });
});
