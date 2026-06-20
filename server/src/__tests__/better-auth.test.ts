import { afterEach, describe, expect, it } from "vitest";
import type { BetterAuthOptions } from "better-auth";
import { getCookies } from "better-auth/cookies";
import {
  buildBetterAuthAdvancedOptions,
  deriveAuthCookiePrefix,
  deriveAuthTrustedOrigins,
  shouldDisableSecureAuthCookies,
} from "../auth/better-auth.js";

const ORIGINAL_INSTANCE_ID = process.env.PAPERCLIP_INSTANCE_ID;
const ORIGINAL_PUBLIC_URL = process.env.PAPERCLIP_PUBLIC_URL;

afterEach(() => {
  if (ORIGINAL_INSTANCE_ID === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
  else process.env.PAPERCLIP_INSTANCE_ID = ORIGINAL_INSTANCE_ID;
  if (ORIGINAL_PUBLIC_URL === undefined) delete process.env.PAPERCLIP_PUBLIC_URL;
  else process.env.PAPERCLIP_PUBLIC_URL = ORIGINAL_PUBLIC_URL;
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
