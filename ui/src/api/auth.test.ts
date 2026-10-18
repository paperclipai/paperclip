import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTenantSessionRecoveryCoordinator,
  tenantSessionRecovery,
} from "@/lib/tenant-session-recovery";
import { authApi } from "./auth";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("authApi.getSession", () => {
  it("returns null for an ordinary local 401", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(authApi.getSession()).resolves.toBeNull();
  });

  it("initiates recovery and stays pending for a Cloud tenant-session 401", async () => {
    const reload = vi.fn();
    const recovery = createTenantSessionRecoveryCoordinator(reload);
    vi.spyOn(tenantSessionRecovery, "recoverIfNeeded").mockImplementation(recovery.recoverIfNeeded);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "tenant_session_required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = authApi.getSession();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

    let settled = false;
    void request.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
  });
});

describe("authApi.signOut", () => {
  it("returns the managed deployment redirect from the response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, redirectTo: "/cloud/logout" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(authApi.signOut()).resolves.toEqual({
      success: true,
      redirectTo: "/cloud/logout",
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/sign-out", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  });
});

describe("authApi.signInEmail two-factor challenge", () => {
  it("surfaces twoFactorRedirect and twoFactorMethods when the account is gated", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ twoFactorRedirect: true, twoFactorMethods: ["totp"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      authApi.signInEmail({ email: "jane@example.com", password: "supersecret" }),
    ).resolves.toEqual({ twoFactorRedirect: true, twoFactorMethods: ["totp"] });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/sign-in/email",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: "jane@example.com", password: "supersecret" }),
      }),
    );
  });

  it("returns an empty result for password-only sign-in (no challenge fields)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      authApi.signInEmail({ email: "jane@example.com", password: "supersecret" }),
    ).resolves.toEqual({});
  });
});

describe("authApi two-factor methods", () => {
  it("enableTotp returns the totpURI and one-time backup codes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          totpURI: "otpauth://totp/Paperclip:jane@example.com?secret=ABCDEFGHIJKLMNOP",
          backupCodes: ["abcd1234", "efgh5678"],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(authApi.enableTotp("supersecret")).resolves.toEqual({
      totpURI: "otpauth://totp/Paperclip:jane@example.com?secret=ABCDEFGHIJKLMNOP",
      backupCodes: ["abcd1234", "efgh5678"],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/two-factor/enable",
      expect.objectContaining({ body: JSON.stringify({ password: "supersecret", method: "totp" }) }),
    );
  });

  it("enableTotp throws an AuthApiError on a malformed 200 payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(authApi.enableTotp("supersecret")).rejects.toMatchObject({
      status: 500,
    });
  });

  it("verifyTotp posts the code to /two-factor/verify-totp", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(authApi.verifyTotp("123456")).resolves.toEqual({ status: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/two-factor/verify-totp",
      expect.objectContaining({ body: JSON.stringify({ code: "123456" }) }),
    );
  });

  it("verifyBackupCode posts the code to /two-factor/verify-backup-code", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ token: "session-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(authApi.verifyBackupCode("abcd1234")).resolves.toEqual({
      token: "session-token",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/two-factor/verify-backup-code",
      expect.objectContaining({ body: JSON.stringify({ code: "abcd1234" }) }),
    );
  });

  it("disableTotp re-proves the password and reports status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(authApi.disableTotp("supersecret")).resolves.toEqual({ status: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/two-factor/disable",
      expect.objectContaining({ body: JSON.stringify({ password: "supersecret" }) }),
    );
  });
});

describe("authApi.getProviders", () => {
  it("normalizes the providers response and GETs /api/auth/providers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ssoProviders: ["google"], googleSsoEnabled: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(authApi.getProviders()).resolves.toEqual({
      ssoProviders: ["google"],
      googleSsoEnabled: true,
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/providers", {
      credentials: "include",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
  });

  it("reports no providers when Google SSO is unconfigured", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ssoProviders: [], googleSsoEnabled: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(authApi.getProviders()).resolves.toEqual({
      ssoProviders: [],
      googleSsoEnabled: false,
    });
  });

  it("throws an AuthApiError on a 500", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "boom" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(authApi.getProviders()).rejects.toMatchObject({ status: 500 });
  });
});

describe("authApi.signInGoogle", () => {
  it("posts provider=google to /api/auth/sign-in/social and returns the authorize URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        url: "https://accounts.google.com/o/oauth2/v2/auth?state=abc&code_challenge=x",
        redirect: true,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await authApi.signInGoogle({ successRedirectUrl: "/auth?next=/issues" });

    expect(result).toEqual({
      url: "https://accounts.google.com/o/oauth2/v2/auth?state=abc&code_challenge=x",
      redirect: true,
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/sign-in/social", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "google",
        callbackURL: "/auth?next=/issues",
        errorCallbackURL: "/auth?next=%2Fissues&google_error=callback_failed",
      }),
    });
  });

  it("omits callback and error URLs when no success redirect is provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ url: "https://accounts.google.com", redirect: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await authApi.signInGoogle();
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/sign-in/social", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "google" }),
    });
  });

  it("surfaces a 404 from an unregistered provider as an AuthApiError", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "NOT_FOUND", code: "provider_not_found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(authApi.signInGoogle()).rejects.toMatchObject({ status: 404, code: "provider_not_found" });
  });
});
