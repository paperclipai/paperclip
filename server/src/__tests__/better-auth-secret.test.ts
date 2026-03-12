import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("better-auth secret validation", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear relevant env vars
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;

    // Reset module cache so the module re-evaluates
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("throws when no auth secret environment variables are set", async () => {
    // Mock better-auth and dependencies to isolate the secret check
    vi.doMock("better-auth", () => ({
      betterAuth: vi.fn(() => ({})),
    }));
    vi.doMock("better-auth/adapters/drizzle", () => ({
      drizzleAdapter: vi.fn(() => ({})),
    }));
    vi.doMock("better-auth/node", () => ({
      toNodeHandler: vi.fn(() => vi.fn()),
    }));
    vi.doMock("@paperclipai/db", () => ({
      authAccounts: {},
      authSessions: {},
      authUsers: {},
      authVerifications: {},
    }));

    const { createBetterAuthInstance } = await import("../auth/better-auth.js");

    const mockDb = {} as any;
    const mockConfig = {
      authBaseUrlMode: "auto",
      authPublicBaseUrl: "",
      deploymentMode: "open",
      allowedHostnames: [],
      authDisableSignUp: false,
    } as any;

    expect(() => createBetterAuthInstance(mockDb, mockConfig)).toThrow(
      /BETTER_AUTH_SECRET or PAPERCLIP_AGENT_JWT_SECRET environment variable must be set/,
    );
  });

  it("does not throw when BETTER_AUTH_SECRET is set", async () => {
    process.env.BETTER_AUTH_SECRET = "test-secret-value";

    vi.doMock("better-auth", () => ({
      betterAuth: vi.fn(() => ({})),
    }));
    vi.doMock("better-auth/adapters/drizzle", () => ({
      drizzleAdapter: vi.fn(() => ({})),
    }));
    vi.doMock("better-auth/node", () => ({
      toNodeHandler: vi.fn(() => vi.fn()),
    }));
    vi.doMock("@paperclipai/db", () => ({
      authAccounts: {},
      authSessions: {},
      authUsers: {},
      authVerifications: {},
    }));

    const { createBetterAuthInstance } = await import("../auth/better-auth.js");

    const mockDb = {} as any;
    const mockConfig = {
      authBaseUrlMode: "auto",
      authPublicBaseUrl: "",
      deploymentMode: "open",
      allowedHostnames: [],
      authDisableSignUp: false,
    } as any;

    expect(() => createBetterAuthInstance(mockDb, mockConfig)).not.toThrow();
  });
});
