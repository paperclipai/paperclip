import { describe, it, expect } from "vitest";
import { ensureDevAgentJwtSecret } from "./dev-jwt-bootstrap.js";

describe("ensureDevAgentJwtSecret", () => {
  it("is a no-op when PAPERCLIP_AGENT_JWT_SECRET is already set", () => {
    const env: Record<string, string | undefined> = {
      PAPERCLIP_AGENT_JWT_SECRET: "preexisting-secret",
    };
    const result = ensureDevAgentJwtSecret(env);
    expect(result.action).toBe("noop");
    expect(result.source).toBe("PAPERCLIP_AGENT_JWT_SECRET");
    expect(env.PAPERCLIP_AGENT_JWT_SECRET).toBe("preexisting-secret");
  });

  it("is a no-op when BETTER_AUTH_SECRET is already set", () => {
    const env: Record<string, string | undefined> = {
      BETTER_AUTH_SECRET: "preexisting-better-auth-secret",
    };
    const result = ensureDevAgentJwtSecret(env);
    expect(result.action).toBe("noop");
    expect(result.source).toBe("BETTER_AUTH_SECRET");
    expect(env.BETTER_AUTH_SECRET).toBe("preexisting-better-auth-secret");
    expect(env.PAPERCLIP_AGENT_JWT_SECRET).toBeUndefined();
  });

  it("generates and sets PAPERCLIP_AGENT_JWT_SECRET when both are unset", () => {
    const env: Record<string, string | undefined> = {};
    const result = ensureDevAgentJwtSecret(env);
    expect(result.action).toBe("generated");
    expect(result.source).toBe("PAPERCLIP_AGENT_JWT_SECRET");
    expect(env.PAPERCLIP_AGENT_JWT_SECRET).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(result.secret).toBe(env.PAPERCLIP_AGENT_JWT_SECRET);
  });

  it("treats whitespace-only existing values as unset", () => {
    const env: Record<string, string | undefined> = {
      PAPERCLIP_AGENT_JWT_SECRET: "   ",
      BETTER_AUTH_SECRET: "",
    };
    const result = ensureDevAgentJwtSecret(env);
    expect(result.action).toBe("generated");
    expect(env.PAPERCLIP_AGENT_JWT_SECRET).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });

  it("generates different secrets across calls", () => {
    const env1: Record<string, string | undefined> = {};
    const env2: Record<string, string | undefined> = {};
    const r1 = ensureDevAgentJwtSecret(env1);
    const r2 = ensureDevAgentJwtSecret(env2);
    expect(r1.secret).not.toBe(r2.secret);
  });
});
