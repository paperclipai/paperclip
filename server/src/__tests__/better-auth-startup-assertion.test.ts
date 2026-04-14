import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBetterAuthInstance } from "../auth/better-auth.js";
import type { Config } from "../config.js";

const BETTER_AUTH_SECRET_ENV = "BETTER_AUTH_SECRET";
const AGENT_JWT_SECRET_ENV = "PAPERCLIP_AGENT_JWT_SECRET";

function makeConfig(deploymentMode: Config["deploymentMode"]): Config {
  return {
    deploymentMode,
    authBaseUrlMode: "auto",
    authPublicBaseUrl: undefined,
    authDisableSignUp: false,
    allowedHostnames: [],
  } as unknown as Config;
}

vi.mock("better-auth", () => ({
  betterAuth: vi.fn(() => ({ __mock: true })),
}));

vi.mock("better-auth/adapters/drizzle", () => ({
  drizzleAdapter: vi.fn(() => ({ __mockAdapter: true })),
}));

vi.mock("@paperclipai/db", () => ({
  authUsers: {},
  authSessions: {},
  authAccounts: {},
  authVerifications: {},
}));

describe("createBetterAuthInstance — startup assertion", () => {
  const originalBetterAuthSecret = process.env[BETTER_AUTH_SECRET_ENV];
  const originalAgentJwtSecret = process.env[AGENT_JWT_SECRET_ENV];

  beforeEach(() => {
    delete process.env[BETTER_AUTH_SECRET_ENV];
    delete process.env[AGENT_JWT_SECRET_ENV];
  });

  afterEach(() => {
    if (originalBetterAuthSecret === undefined) delete process.env[BETTER_AUTH_SECRET_ENV];
    else process.env[BETTER_AUTH_SECRET_ENV] = originalBetterAuthSecret;
    if (originalAgentJwtSecret === undefined) delete process.env[AGENT_JWT_SECRET_ENV];
    else process.env[AGENT_JWT_SECRET_ENV] = originalAgentJwtSecret;
  });

  it("throws when deploymentMode is authenticated and no secret is configured (falls back to dev secret)", () => {
    expect(() => createBetterAuthInstance({} as any, makeConfig("authenticated"))).toThrow(
      "FATAL: BETTER_AUTH_SECRET must be set in authenticated deployment mode.",
    );
  });

  it("throws when deploymentMode is authenticated and BETTER_AUTH_SECRET equals the dev default", () => {
    process.env[BETTER_AUTH_SECRET_ENV] = "paperclip-dev-secret";
    expect(() => createBetterAuthInstance({} as any, makeConfig("authenticated"))).toThrow(
      "FATAL: BETTER_AUTH_SECRET must be set in authenticated deployment mode.",
    );
  });

  it("throws when deploymentMode is authenticated and PAPERCLIP_AGENT_JWT_SECRET equals the dev default", () => {
    process.env[AGENT_JWT_SECRET_ENV] = "paperclip-dev-secret";
    expect(() => createBetterAuthInstance({} as any, makeConfig("authenticated"))).toThrow(
      "FATAL: BETTER_AUTH_SECRET must be set in authenticated deployment mode.",
    );
  });

  it("does not throw when deploymentMode is authenticated and a real secret is configured", () => {
    process.env[BETTER_AUTH_SECRET_ENV] = "a-real-production-secret-value";
    expect(() => createBetterAuthInstance({} as any, makeConfig("authenticated"))).not.toThrow();
  });

  it("does not throw in local_trusted mode even without a secret configured", () => {
    expect(() => createBetterAuthInstance({} as any, makeConfig("local_trusted"))).not.toThrow();
  });

  it("does not throw in local_trusted mode even when secret is explicitly set to dev default", () => {
    process.env[BETTER_AUTH_SECRET_ENV] = "paperclip-dev-secret";
    expect(() => createBetterAuthInstance({} as any, makeConfig("local_trusted"))).not.toThrow();
  });
});
