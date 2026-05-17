import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalAgentJwt, verifyLocalAgentJwt } from "../agent-auth-jwt.js";

describe("agent local JWT", () => {
  const secretEnv = "PAPERCLIP_AGENT_JWT_SECRET";
  const betterAuthSecretEnv = "BETTER_AUTH_SECRET";
  const ttlEnv = "PAPERCLIP_AGENT_JWT_TTL_SECONDS";
  const issuerEnv = "PAPERCLIP_AGENT_JWT_ISSUER";
  const audienceEnv = "PAPERCLIP_AGENT_JWT_AUDIENCE";
  const deniedRunIdsEnv = "PAPERCLIP_AGENT_JWT_DENIED_RUN_IDS";

  const originalEnv = {
    secret: process.env[secretEnv],
    betterAuthSecret: process.env[betterAuthSecretEnv],
    ttl: process.env[ttlEnv],
    issuer: process.env[issuerEnv],
    audience: process.env[audienceEnv],
    deniedRunIds: process.env[deniedRunIdsEnv],
  };

  beforeEach(() => {
    process.env[secretEnv] = "test-secret";
    delete process.env[betterAuthSecretEnv];
    process.env[ttlEnv] = "3600";
    delete process.env[issuerEnv];
    delete process.env[audienceEnv];
    delete process.env[deniedRunIdsEnv];
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
    if (originalEnv.deniedRunIds === undefined) delete process.env[deniedRunIdsEnv];
    else process.env[deniedRunIdsEnv] = originalEnv.deniedRunIds;
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

  it("rejects denied run ids while allowing other valid agent JWTs", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    process.env[deniedRunIdsEnv] = [
      "576c63c1-6ddc-4daf-93b6-de30c3d34f32",
      "c79d03a8-6929-499b-80fb-7b45ca48db5c",
      "b42a052b-3ddc-4f2b-ba61-03bbe37f53f4",
    ].join(",");

    const deniedToken = createLocalAgentJwt(
      "agent-1",
      "company-1",
      "codex_local",
      "c79d03a8-6929-499b-80fb-7b45ca48db5c",
    );
    const allowedToken = createLocalAgentJwt(
      "agent-1",
      "company-1",
      "codex_local",
      "f1da3a6c-cfaa-4e66-9a6e-3e8277a3cf16",
    );

    expect(verifyLocalAgentJwt(deniedToken!)).toBeNull();
    expect(verifyLocalAgentJwt(allowedToken!)).toMatchObject({
      sub: "agent-1",
      company_id: "company-1",
      run_id: "f1da3a6c-cfaa-4e66-9a6e-3e8277a3cf16",
    });
  });

  it("accepts a JSON-array denied run id setting", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    process.env[deniedRunIdsEnv] = JSON.stringify(["run-1"]);
    const token = createLocalAgentJwt("agent-1", "company-1", "codex_local", "run-1");

    expect(verifyLocalAgentJwt(token!)).toBeNull();
  });
});
