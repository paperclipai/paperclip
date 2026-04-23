import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipConfig } from "../config/schema.js";
import { deploymentAuthCheck } from "./deployment-auth-check.js";

type ServerConfig = PaperclipConfig["server"];
type AuthConfig = PaperclipConfig["auth"];

function makeConfig(overrides: {
  deploymentMode?: ServerConfig["deploymentMode"];
  exposure?: ServerConfig["exposure"];
  host?: string;
  bind?: ServerConfig["bind"];
  auth?: Partial<AuthConfig>;
}): PaperclipConfig {
  return {
    server: {
      deploymentMode: overrides.deploymentMode ?? "local_trusted",
      exposure: overrides.exposure ?? "private",
      host: overrides.host ?? "127.0.0.1",
      bind: overrides.bind,
      port: 3100,
    },
    auth: {
      baseUrlMode: "auto",
      publicBaseUrl: undefined,
      jwtSecret: null,
      ...overrides.auth,
    },
  } as unknown as PaperclipConfig;
}

// ============================================================================
// deploymentAuthCheck — local_trusted mode
// ============================================================================

describe("deploymentAuthCheck — local_trusted mode", () => {
  it("returns pass for local_trusted with loopback bind", () => {
    const result = deploymentAuthCheck(makeConfig({
      deploymentMode: "local_trusted",
      bind: "loopback",
    }));
    expect(result.status).toBe("pass");
  });

  it("infers loopback bind from 127.0.0.1 host when bind is not set", () => {
    const result = deploymentAuthCheck(makeConfig({
      deploymentMode: "local_trusted",
      host: "127.0.0.1",
    }));
    expect(result.status).toBe("pass");
  });

  it("infers loopback bind from localhost host when bind is not set", () => {
    const result = deploymentAuthCheck(makeConfig({
      deploymentMode: "local_trusted",
      host: "localhost",
    }));
    expect(result.status).toBe("pass");
  });

  it("returns fail for local_trusted with non-loopback bind", () => {
    const result = deploymentAuthCheck(makeConfig({
      deploymentMode: "local_trusted",
      bind: "lan",
    }));
    expect(result.status).toBe("fail");
  });

  it("fail message mentions loopback requirement", () => {
    const result = deploymentAuthCheck(makeConfig({
      deploymentMode: "local_trusted",
      bind: "lan",
    }));
    expect(result.message).toContain("loopback");
  });

  it("sets name to 'Deployment/auth mode'", () => {
    const result = deploymentAuthCheck(makeConfig({ deploymentMode: "local_trusted", bind: "loopback" }));
    expect(result.name).toBe("Deployment/auth mode");
  });
});

// ============================================================================
// deploymentAuthCheck — authenticated modes (no BETTER_AUTH_SECRET)
// ============================================================================

describe("deploymentAuthCheck — authenticated mode, no secret", () => {
  beforeEach(() => {
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns fail when BETTER_AUTH_SECRET and JWT secret are both missing", () => {
    const result = deploymentAuthCheck(makeConfig({ deploymentMode: "authenticated" }));
    expect(result.status).toBe("fail");
  });

  it("fail message mentions BETTER_AUTH_SECRET", () => {
    const result = deploymentAuthCheck(makeConfig({ deploymentMode: "authenticated" }));
    expect(result.message).toContain("BETTER_AUTH_SECRET");
  });
});

// ============================================================================
// deploymentAuthCheck — authenticated modes (secret present)
// ============================================================================

describe("deploymentAuthCheck — authenticated mode, secret present", () => {
  beforeEach(() => {
    vi.stubEnv("BETTER_AUTH_SECRET", "my-auth-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns pass for private exposure with explicit baseUrl mode set", () => {
    const result = deploymentAuthCheck(makeConfig({
      deploymentMode: "authenticated",
      exposure: "private",
      auth: { baseUrlMode: "auto" },
    }));
    expect(result.status).toBe("pass");
  });

  it("returns fail when explicit baseUrlMode lacks publicBaseUrl", () => {
    const result = deploymentAuthCheck(makeConfig({
      deploymentMode: "authenticated",
      exposure: "private",
      auth: { baseUrlMode: "explicit", publicBaseUrl: undefined },
    }));
    expect(result.status).toBe("fail");
  });

  it("returns fail for public exposure without explicit publicBaseUrl", () => {
    const result = deploymentAuthCheck(makeConfig({
      deploymentMode: "authenticated",
      exposure: "public",
      auth: { baseUrlMode: "auto" },
    }));
    expect(result.status).toBe("fail");
  });

  it("returns warn for public exposure with http:// publicBaseUrl", () => {
    const result = deploymentAuthCheck(makeConfig({
      deploymentMode: "authenticated",
      exposure: "public",
      auth: { baseUrlMode: "explicit", publicBaseUrl: "http://example.com" },
    }));
    expect(result.status).toBe("warn");
    expect(result.message).toContain("https://");
  });

  it("returns fail for public exposure with invalid publicBaseUrl", () => {
    const result = deploymentAuthCheck(makeConfig({
      deploymentMode: "authenticated",
      exposure: "public",
      auth: { baseUrlMode: "explicit", publicBaseUrl: "not-a-url" },
    }));
    expect(result.status).toBe("fail");
  });

  it("returns pass for public exposure with https:// publicBaseUrl", () => {
    const result = deploymentAuthCheck(makeConfig({
      deploymentMode: "authenticated",
      exposure: "public",
      auth: { baseUrlMode: "explicit", publicBaseUrl: "https://paperclip.example.com" },
    }));
    expect(result.status).toBe("pass");
  });

});

// ============================================================================
// deploymentAuthCheck — JWT secret fallback (no BETTER_AUTH_SECRET in env)
// ============================================================================

describe("deploymentAuthCheck — JWT secret fallback", () => {
  let savedBetterAuthSecret: string | undefined;

  beforeEach(() => {
    // Stash and delete BETTER_AUTH_SECRET so the ?? fallback can fire
    savedBetterAuthSecret = process.env.BETTER_AUTH_SECRET;
    delete process.env.BETTER_AUTH_SECRET;
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "jwt-secret");
  });

  afterEach(() => {
    if (savedBetterAuthSecret !== undefined) {
      process.env.BETTER_AUTH_SECRET = savedBetterAuthSecret;
    }
    vi.unstubAllEnvs();
  });

  it("returns pass when only PAPERCLIP_AGENT_JWT_SECRET is set", () => {
    const result = deploymentAuthCheck(makeConfig({
      deploymentMode: "authenticated",
      exposure: "private",
    }));
    expect(result.status).toBe("pass");
  });
});
