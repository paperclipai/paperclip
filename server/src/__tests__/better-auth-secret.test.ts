import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("resolveAuthSecret", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("uses BETTER_AUTH_SECRET when set", async () => {
    process.env.BETTER_AUTH_SECRET = "explicit-secret";
    const { resolveAuthSecret } = await import("../auth/better-auth.js");
    expect(resolveAuthSecret("authenticated")).toBe("explicit-secret");
  });

  it("falls back to PAPERCLIP_AGENT_JWT_SECRET", async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "jwt-secret";
    const { resolveAuthSecret } = await import("../auth/better-auth.js");
    expect(resolveAuthSecret("authenticated")).toBe("jwt-secret");
  });

  it("throws in authenticated mode when no secret is set", async () => {
    const { resolveAuthSecret } = await import("../auth/better-auth.js");
    expect(() => resolveAuthSecret("authenticated")).toThrow(
      /BETTER_AUTH_SECRET.*PAPERCLIP_AGENT_JWT_SECRET/,
    );
  });

  it("derives deterministic secret in local_trusted mode", async () => {
    const { resolveAuthSecret } = await import("../auth/better-auth.js");
    const secret1 = resolveAuthSecret("local_trusted");
    const secret2 = resolveAuthSecret("local_trusted");
    expect(secret1).toBe(secret2);
    expect(secret1.length).toBeGreaterThan(20);
    expect(secret1).not.toBe("paperclip-dev-secret");
  });
});
