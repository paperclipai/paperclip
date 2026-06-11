import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalAgentJwt, verifyLocalAgentJwt } from "../agent-auth-jwt.js";

describe("agent local JWT", () => {
  const secretEnv = "PAPERCLIP_AGENT_JWT_SECRET";
  const betterAuthSecretEnv = "BETTER_AUTH_SECRET";
  const ttlEnv = "PAPERCLIP_AGENT_JWT_TTL_SECONDS";
  const issuerEnv = "PAPERCLIP_AGENT_JWT_ISSUER";
  const audienceEnv = "PAPERCLIP_AGENT_JWT_AUDIENCE";

  const originalEnv = {
    secret: process.env[secretEnv],
    betterAuthSecret: process.env[betterAuthSecretEnv],
    ttl: process.env[ttlEnv],
    issuer: process.env[issuerEnv],
    audience: process.env[audienceEnv],
  };

  beforeEach(() => {
    process.env[secretEnv] = "test-secret";
    delete process.env[betterAuthSecretEnv];
    process.env[ttlEnv] = "3600";
    delete process.env[issuerEnv];
    delete process.env[audienceEnv];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalEnv.secret === undefined) delete process.env[secretEnv];
    else process.env[secretEnv] = originalEnv.secret;
    if (originalEnv.betterAuthSecret === undefined) delete process.env[betterAuthSecretEnv];
    else process.env[betterAuthSecretEnv] = originalEnv.betterAuthSecret;
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

  it("falls back to BETTER_AUTH_SECRET when PAPERCLIP_AGENT_JWT_SECRET is absent", () => {
    delete process.env[secretEnv];
    process.env[betterAuthSecretEnv] = "fallback-secret";
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");
    expect(typeof token).toBe("string");

    const claims = verifyLocalAgentJwt(token!);
    expect(claims).toMatchObject({
      sub: "agent-1",
      company_id: "company-1",
      adapter_type: "claude_local",
      run_id: "run-1",
    });
  });

  it("rejects expired tokens", () => {
    process.env[ttlEnv] = "1";
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");

    vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"));
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

  it("round-trips an oauth.connectionIds claim through create + verify", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt(
      "agent-1",
      "company-1",
      "claude_local",
      "run-1",
      { connectionIds: ["conn-a", "conn-b"] },
    );
    expect(typeof token).toBe("string");

    const claims = verifyLocalAgentJwt(token!);
    expect(claims?.oauth?.connectionIds).toEqual(["conn-a", "conn-b"]);
  });

  it("omits oauth claim when not provided", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");
    const claims = verifyLocalAgentJwt(token!);
    expect(claims).not.toBeNull();
    expect(claims?.oauth).toBeUndefined();
  });

  it("preserves an empty connectionIds array round-trip", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt(
      "agent-1",
      "company-1",
      "claude_local",
      "run-1",
      { connectionIds: [] },
    );
    const claims = verifyLocalAgentJwt(token!);
    expect(claims?.oauth?.connectionIds).toEqual([]);
  });

  it("filters non-string entries out of the connectionIds claim on verify", () => {
    // Hand-craft a token whose payload has a malformed connectionIds entry
    // to confirm verify defends against non-string values being smuggled in.
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const realToken = createLocalAgentJwt(
      "agent-1",
      "company-1",
      "claude_local",
      "run-1",
      { connectionIds: ["conn-a"] },
    )!;
    const [headerB64, originalClaimsB64] = realToken.split(".");
    const claims = JSON.parse(
      Buffer.from(originalClaimsB64, "base64url").toString("utf8"),
    );
    claims.oauth = { connectionIds: ["conn-a", 123, null] };
    const tamperedClaimsB64 = Buffer.from(JSON.stringify(claims), "utf8").toString(
      "base64url",
    );
    const tamperedSig = createHmac("sha256", "test-secret")
      .update(`${headerB64}.${tamperedClaimsB64}`)
      .digest("base64url");
    const tamperedToken = `${headerB64}.${tamperedClaimsB64}.${tamperedSig}`;
    const verified = verifyLocalAgentJwt(tamperedToken);
    expect(verified?.oauth?.connectionIds).toEqual(["conn-a"]);
  });
});
