import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalAgentJwt, verifyLocalAgentJwt } from "../agent-auth-jwt.js";

describe("agent local JWT", () => {
  const secretEnv = "PAPERCLIP_AGENT_JWT_SECRET";
  const ttlEnv = "PAPERCLIP_AGENT_JWT_TTL_SECONDS";
  const issuerEnv = "PAPERCLIP_AGENT_JWT_ISSUER";
  const audienceEnv = "PAPERCLIP_AGENT_JWT_AUDIENCE";

  const originalEnv = {
    secret: process.env[secretEnv],
    ttl: process.env[ttlEnv],
    issuer: process.env[issuerEnv],
    audience: process.env[audienceEnv],
  };

  beforeEach(() => {
    process.env[secretEnv] = "test-secret";
    process.env[ttlEnv] = "3600";
    delete process.env[issuerEnv];
    delete process.env[audienceEnv];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalEnv.secret === undefined) delete process.env[secretEnv];
    else process.env[secretEnv] = originalEnv.secret;
    if (originalEnv.ttl === undefined) delete process.env[ttlEnv];
    else process.env[ttlEnv] = originalEnv.ttl;
    if (originalEnv.issuer === undefined) delete process.env[issuerEnv];
    else process.env[issuerEnv] = originalEnv.issuer;
    if (originalEnv.audience === undefined) delete process.env[audienceEnv];
    else process.env[audienceEnv] = originalEnv.audience;
  });

  it("creates and verifies a token", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");
    expect(typeof token).toBe("string");

    const claims = verifyLocalAgentJwt(token!);
    expect(claims).toMatchObject({
      sub: "agent-1",
      company_id: "company-1",
      adapter_type: "claude_local",
      run_id: "run-1",
      iss: "paperclip",
      aud: "paperclip-api",
    });
  });

  it("returns null when secret is missing", () => {
    process.env[secretEnv] = "";
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");
    expect(token).toBeNull();
    expect(verifyLocalAgentJwt("abc.def.ghi")).toBeNull();
  });

  it("rejects expired tokens", () => {
    process.env[ttlEnv] = "300";
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");

    // Advance past the 300s (minimum) TTL
    vi.setSystemTime(new Date("2026-01-01T00:06:00.000Z"));
    expect(verifyLocalAgentJwt(token!)).toBeNull();
  });

  it("rejects issuer/audience mismatch", () => {
    process.env[issuerEnv] = "custom-issuer";
    process.env[audienceEnv] = "custom-audience";
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "codex_local", "run-1");

    process.env[issuerEnv] = "paperclip";
    process.env[audienceEnv] = "paperclip-api";
    expect(verifyLocalAgentJwt(token!)).toBeNull();
  });
});

describe("jwtConfig TTL bounds", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("clamps TTL to minimum 300s", async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "test-secret";
    process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = "10";
    const { createLocalAgentJwt } = await import("../agent-auth-jwt.js");
    const token = createLocalAgentJwt("agent-1", "company-1", "claude", "run-1");
    expect(token).toBeTruthy();
    const payload = JSON.parse(Buffer.from(token!.split(".")[1], "base64url").toString());
    expect(payload.exp - payload.iat).toBe(300);
  });

  it("clamps TTL to maximum 30 days", async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "test-secret";
    process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = "99999999";
    const { createLocalAgentJwt } = await import("../agent-auth-jwt.js");
    const token = createLocalAgentJwt("agent-1", "company-1", "claude", "run-1");
    expect(token).toBeTruthy();
    const payload = JSON.parse(Buffer.from(token!.split(".")[1], "base64url").toString());
    expect(payload.exp - payload.iat).toBe(30 * 24 * 60 * 60);
  });

  it("uses configured TTL within bounds", async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "test-secret";
    process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = "3600";
    const { createLocalAgentJwt } = await import("../agent-auth-jwt.js");
    const token = createLocalAgentJwt("agent-1", "company-1", "claude", "run-1");
    expect(token).toBeTruthy();
    const payload = JSON.parse(Buffer.from(token!.split(".")[1], "base64url").toString());
    expect(payload.exp - payload.iat).toBe(3600);
  });
});
