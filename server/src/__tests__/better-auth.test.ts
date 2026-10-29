import { afterEach, describe, expect, it } from "vitest";
import type { BetterAuthOptions } from "better-auth";
import { getCookies } from "better-auth/cookies";
import type { Db } from "@paperclipai/db";
import {
  buildBetterAuthAdvancedOptions,
  buildBetterAuthRateLimitOptions,
  createBetterAuthInstance,
  deriveAuthCookiePrefix,
  deriveAuthTrustedOrigins,
  resolveAuthPublicUrl,
  resolvePasskeyRelyingParty,
  resolveTrustedPasskeyRelyingParty,
  shouldDisableSecureAuthCookies,
} from "../auth/better-auth.js";
import type { Config } from "../config.js";

const ORIGINAL_INSTANCE_ID = process.env.PAPERCLIP_INSTANCE_ID;
const ORIGINAL_PUBLIC_URL = process.env.PAPERCLIP_PUBLIC_URL;
const ORIGINAL_AUTH_SECRET = process.env.BETTER_AUTH_SECRET;

afterEach(() => {
  if (ORIGINAL_INSTANCE_ID === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
  else process.env.PAPERCLIP_INSTANCE_ID = ORIGINAL_INSTANCE_ID;
  if (ORIGINAL_PUBLIC_URL === undefined) delete process.env.PAPERCLIP_PUBLIC_URL;
  else process.env.PAPERCLIP_PUBLIC_URL = ORIGINAL_PUBLIC_URL;
  if (ORIGINAL_AUTH_SECRET === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = ORIGINAL_AUTH_SECRET;
});

describe("Better Auth cookie scoping", () => {
  it("derives an instance-scoped cookie prefix", () => {
    expect(deriveAuthCookiePrefix("default")).toBe("paperclip-default");
    expect(deriveAuthCookiePrefix("PAP-1601-worktree")).toBe("paperclip-PAP-1601-worktree");
  });

  it("uses PAPERCLIP_INSTANCE_ID for the Better Auth cookie prefix", () => {
    process.env.PAPERCLIP_INSTANCE_ID = "sat-worktree";

    const advanced = buildBetterAuthAdvancedOptions({ disableSecureCookies: false });

    expect(advanced).toEqual({
      cookiePrefix: "paperclip-sat-worktree",
    });
    expect(getCookies({ advanced } as BetterAuthOptions).sessionToken.name).toMatch(
      /paperclip-sat-worktree\.session_token$/,
    );
  });

  it("keeps local http auth cookies non-secure while preserving the scoped prefix", () => {
    process.env.PAPERCLIP_INSTANCE_ID = "pap-worktree";

    expect(buildBetterAuthAdvancedOptions({ disableSecureCookies: true })).toEqual({
      cookiePrefix: "paperclip-pap-worktree",
      useSecureCookies: false,
    });
    expect(getCookies({
      advanced: buildBetterAuthAdvancedOptions({ disableSecureCookies: true }),
    } as BetterAuthOptions).sessionToken.name).toBe("paperclip-pap-worktree.session_token");
  });

  it("enables Better Auth rate limiting for authenticated private instances by default", () => {
    expect(buildBetterAuthRateLimitOptions({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
    })).toEqual({ enabled: true });
  });

  it("keeps Better Auth rate limiting enabled for authenticated public instances", () => {
    expect(buildBetterAuthRateLimitOptions({
      deploymentMode: "authenticated",
      deploymentExposure: "public",
    })).toEqual({ enabled: true });
  });

  it("allows an explicit Better Auth rate-limit override", () => {
    expect(buildBetterAuthRateLimitOptions({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      override: "true",
    })).toEqual({ enabled: true });

    expect(buildBetterAuthRateLimitOptions({
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      override: "false",
    })).toEqual({ enabled: false });
  });

  it("disables secure cookies for authenticated private auto-origin dev servers", () => {
    expect(shouldDisableSecureAuthCookies({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authBaseUrlMode: "auto",
      authPublicBaseUrl: undefined,
      publicUrl: undefined,
    })).toBe(true);
  });

  it("keeps secure cookies for authenticated public auto-origin servers", () => {
    expect(shouldDisableSecureAuthCookies({
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      authBaseUrlMode: "auto",
      authPublicBaseUrl: undefined,
      publicUrl: undefined,
    })).toBe(false);
  });

  it("uses an explicit public URL when deciding whether secure cookies are required", () => {
    expect(shouldDisableSecureAuthCookies({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authBaseUrlMode: "auto",
      authPublicBaseUrl: undefined,
      publicUrl: "https://paperclip.example.test",
    })).toBe(false);

    expect(shouldDisableSecureAuthCookies({
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: "http://paperclip.local.test:3100",
      publicUrl: undefined,
    })).toBe(true);
  });

  it("disables secure cookies when no canonical public auth URL is configured", () => {
    delete process.env.PAPERCLIP_PUBLIC_URL;

    expect(shouldDisableSecureAuthCookies({
      deploymentMode: "authenticated",
      authBaseUrlMode: "auto",
      authPublicBaseUrl: undefined,
    } as Parameters<typeof shouldDisableSecureAuthCookies>[0])).toBe(true);
  });

  it("derives secure cookie behavior from the configured public auth URL", () => {
    delete process.env.PAPERCLIP_PUBLIC_URL;

    expect(shouldDisableSecureAuthCookies({
      deploymentMode: "authenticated",
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: "http://paperclip-dev:46259",
    } as Parameters<typeof shouldDisableSecureAuthCookies>[0])).toBe(true);
    expect(shouldDisableSecureAuthCookies({
      deploymentMode: "authenticated",
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: "https://paperclip.example.test",
    } as Parameters<typeof shouldDisableSecureAuthCookies>[0])).toBe(false);
  });

  it("uses the caller-resolved public URL for cookie security", () => {
    process.env.PAPERCLIP_PUBLIC_URL = "https://ignored.example.test";

    expect(shouldDisableSecureAuthCookies({
      deploymentMode: "authenticated",
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: "https://paperclip.example.test",
      publicUrl: "http://paperclip-dev:46259",
    } as Parameters<typeof shouldDisableSecureAuthCookies>[0])).toBe(true);
  });

  it("disables secure cookies for private authenticated auto mode without a public URL", () => {
    expect(shouldDisableSecureAuthCookies({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authBaseUrlMode: "auto",
      authPublicBaseUrl: undefined,
    })).toBe(true);
  });

  it("disables secure cookies for explicit HTTP public URLs", () => {
    expect(shouldDisableSecureAuthCookies({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: "http://board.example.test:3101",
    })).toBe(true);
  });

  it("keeps secure cookies for explicit HTTPS public URLs", () => {
    expect(shouldDisableSecureAuthCookies({
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: "https://board.example.test",
    })).toBe(false);
  });

  it("disables secure cookies only for HTTP loopback requests in a managed HTTPS runtime", () => {
    const managedRuntimeInput = {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: "https://worktree.example.test",
      publicUrl: "https://worktree.example.test",
      managedRuntimePublicUrl: "https://worktree.example.test",
    } as const;

    expect(shouldDisableSecureAuthCookies({
      ...managedRuntimeInput,
      requestUrl: "http://127.0.0.1:42013/api/auth/sign-in/email",
    } as Parameters<typeof shouldDisableSecureAuthCookies>[0])).toBe(true);
    expect(shouldDisableSecureAuthCookies({
      ...managedRuntimeInput,
      requestUrl: "https://worktree.example.test/api/auth/sign-in/email",
    } as Parameters<typeof shouldDisableSecureAuthCookies>[0])).toBe(false);
    expect(shouldDisableSecureAuthCookies({
      ...managedRuntimeInput,
      managedRuntimePublicUrl: undefined,
      requestUrl: "http://127.0.0.1:42013/api/auth/sign-in/email",
    } as Parameters<typeof shouldDisableSecureAuthCookies>[0])).toBe(false);
    expect(shouldDisableSecureAuthCookies({
      ...managedRuntimeInput,
      requestUrl: "http://board.example.test:42013/api/auth/sign-in/email",
    } as Parameters<typeof shouldDisableSecureAuthCookies>[0])).toBe(false);
  });

  it("adds hostname port variants for authenticated mode on non-default ports", () => {
    const trustedOrigins = deriveAuthTrustedOrigins({
      deploymentMode: "authenticated",
      authBaseUrlMode: "auto",
      authPublicBaseUrl: undefined,
      allowedHostnames: ["Board.Example.Test"],
      port: 3101,
    } as Parameters<typeof deriveAuthTrustedOrigins>[0]);

    expect(trustedOrigins).toEqual(expect.arrayContaining([
      "https://board.example.test",
      "http://board.example.test",
      "https://board.example.test:3101",
      "http://board.example.test:3101",
    ]));
  });

  it("prefers an explicit resolved listen port over the configured port", () => {
    const trustedOrigins = deriveAuthTrustedOrigins({
      deploymentMode: "authenticated",
      authBaseUrlMode: "auto",
      authPublicBaseUrl: undefined,
      allowedHostnames: ["board.example.test"],
      port: 3100,
    } as Parameters<typeof deriveAuthTrustedOrigins>[0], { listenPort: 3101 });

    expect(trustedOrigins).toEqual(expect.arrayContaining([
      "https://board.example.test:3101",
      "http://board.example.test:3101",
    ]));
    expect(trustedOrigins).not.toContain("https://board.example.test:3100");
    expect(trustedOrigins).not.toContain("http://board.example.test:3100");
  });
});

describe("Passkey relying party", () => {
  it("serves passkeys from the trusted auth base URL, not PAPERCLIP_PUBLIC_URL", () => {
    process.env.BETTER_AUTH_SECRET = "better-auth-secret-for-passkey-rp-tests";
    process.env.PAPERCLIP_PUBLIC_URL = "https://public.example.test";
    const config = {
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: "https://auth.example.test",
      authDisableSignUp: false,
      allowedHostnames: [],
      port: 3100,
    } as unknown as Config;
    const trustedOrigins = deriveAuthTrustedOrigins(config);

    const { passkeyRelyingParty } = createBetterAuthInstance({} as Db, config, trustedOrigins);

    expect(passkeyRelyingParty).toEqual({ rpID: "auth.example.test", origin: "https://auth.example.test" });
    expect(trustedOrigins).toContain(passkeyRelyingParty?.origin);
  });

  it("uses the public HTTPS hostname as the relying party ID", () => {
    expect(resolvePasskeyRelyingParty("https://paperclip.example.com/some/path")).toEqual({
      rpID: "paperclip.example.com",
      origin: "https://paperclip.example.com",
    });
    expect(resolvePasskeyRelyingParty("https://paperclip.example.com:8443")).toEqual({
      rpID: "paperclip.example.com",
      origin: "https://paperclip.example.com:8443",
    });
  });

  it("keeps passkeys for auto-mode instances whose public URL is a trusted origin", () => {
    process.env.BETTER_AUTH_SECRET = "better-auth-secret-for-passkey-rp-tests";
    process.env.PAPERCLIP_PUBLIC_URL = "https://public.example.test";
    const config = {
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      authBaseUrlMode: "auto",
      authPublicBaseUrl: "https://public.example.test",
      authDisableSignUp: false,
      allowedHostnames: ["public.example.test"],
      port: 443,
    } as unknown as Config;

    const { passkeyRelyingParty } = createBetterAuthInstance({} as Db, config, deriveAuthTrustedOrigins(config));

    expect(passkeyRelyingParty).toEqual({ rpID: "public.example.test", origin: "https://public.example.test" });
  });

  it("turns passkeys off when their origin is not trusted", () => {
    expect(resolveTrustedPasskeyRelyingParty("https://public.example.test", ["https://auth.example.test"])).toBeNull();
    expect(resolveTrustedPasskeyRelyingParty("https://auth.example.test", ["https://auth.example.test"])).toEqual({
      rpID: "auth.example.test",
      origin: "https://auth.example.test",
    });
  });

  it("allows plain HTTP only for localhost", () => {
    expect(resolvePasskeyRelyingParty("http://localhost:3100")).toEqual({
      rpID: "localhost",
      origin: "http://localhost:3100",
    });
    expect(resolvePasskeyRelyingParty("http://paperclip.example.com")).toBeNull();
  });

  it("disables passkeys when the browser cannot use the host as a relying party ID", () => {
    expect(resolvePasskeyRelyingParty(undefined)).toBeNull();
    expect(resolvePasskeyRelyingParty("not a url")).toBeNull();
    expect(resolvePasskeyRelyingParty("http://127.0.0.1:3100")).toBeNull();
    expect(resolvePasskeyRelyingParty("https://10.0.0.5")).toBeNull();
    expect(resolvePasskeyRelyingParty("https://[::1]:3100")).toBeNull();
  });

  it("prefers PAPERCLIP_PUBLIC_URL over an explicit auth base URL", () => {
    const config = { authBaseUrlMode: "explicit" as const, authPublicBaseUrl: "https://auth.example.com" };
    expect(resolveAuthPublicUrl(config, {})).toBe("https://auth.example.com");
    expect(resolveAuthPublicUrl(config, { PAPERCLIP_PUBLIC_URL: " https://public.example.com " })).toBe(
      "https://public.example.com",
    );
    expect(resolveAuthPublicUrl({ authBaseUrlMode: "auto", authPublicBaseUrl: "https://auth.example.com" }, {}))
      .toBeUndefined();
  });
});
