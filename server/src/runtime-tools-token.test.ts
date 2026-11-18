import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeToolsToken, REMOTE_GITHUB_CREDENTIALS_TTL_SECONDS, verifyRuntimeToolsToken } from "./runtime-tools-token.js";

describe("runtime connection tools token", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("binds the token to company, agent, run, responsible user, and scope", () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "test-runtime-tools-secret");
    vi.setSystemTime(new Date("2026-08-26T12:00:00.000Z"));
    const minted = createRuntimeToolsToken({
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
      responsibleUserId: "user-1",
    });
    expect(minted).not.toBeNull();
    expect(verifyRuntimeToolsToken(minted!.token)).toMatchObject({
      sub: "agent-1",
      company_id: "company-1",
      run_id: "run-1",
      responsible_user_id: "user-1",
      scope: "connection_intents",
    });
  });

  it("rejects tampering and expiry", () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "test-runtime-tools-secret");
    vi.setSystemTime(new Date("2026-08-26T12:00:00.000Z"));
    const minted = createRuntimeToolsToken({
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
      responsibleUserId: "user-1",
    })!;
    expect(verifyRuntimeToolsToken(`${minted.token.slice(0, -1)}x`)).toBeNull();
    vi.setSystemTime(new Date("2026-08-26T13:00:01.000Z"));
    expect(verifyRuntimeToolsToken(minted.token)).toBeNull();
  });

  it("caps the GitHub broker token lifetime for remote runs at 7 days or less", () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "test-runtime-tools-secret");
    vi.setSystemTime(new Date("2026-08-26T12:00:00.000Z"));
    const base = { agentId: "agent-1", companyId: "company-1", runId: "run-1", responsibleUserId: "user-1", scope: "github_credentials" as const };
    const now = Math.floor(Date.now() / 1000);
    const remote = createRuntimeToolsToken({ ...base, maxTtlSeconds: REMOTE_GITHUB_CREDENTIALS_TTL_SECONDS })!;
    const remoteClaims = verifyRuntimeToolsToken(remote.token, "github_credentials")!;
    expect(remoteClaims.exp - now).toBeLessThanOrEqual(7 * 24 * 60 * 60);
    expect(remoteClaims.exp - now).toBeGreaterThan(0);
    expect(remote.expiresAt).toBe(new Date(remoteClaims.exp * 1000).toISOString());
    // Local runs keep the existing 30 day lifetime.
    const local = verifyRuntimeToolsToken(createRuntimeToolsToken(base)!.token, "github_credentials")!;
    expect(local.exp - now).toBe(30 * 24 * 60 * 60);
    // A cap can only shorten, and the connection-intents default is unaffected by a larger cap.
    const shorter = verifyRuntimeToolsToken(createRuntimeToolsToken({ ...base, maxTtlSeconds: 600 })!.token, "github_credentials")!;
    expect(shorter.exp - now).toBe(600);
    const intents = verifyRuntimeToolsToken(createRuntimeToolsToken({ ...base, scope: undefined, maxTtlSeconds: 7 * 86400 })!.token)!;
    expect(intents.exp - now).toBe(3600);
  });

  it("rejects an invalid cap instead of failing open, and floors a fractional one", () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "test-runtime-tools-secret");
    vi.setSystemTime(new Date("2026-08-26T12:00:00.000Z"));
    const now = Math.floor(Date.now() / 1000);
    const base = { agentId: "agent-1", companyId: "company-1", runId: "run-1", responsibleUserId: "user-1", scope: "github_credentials" as const };
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createRuntimeToolsToken({ ...base, maxTtlSeconds: bad })).toThrow();
    }
    const claims = verifyRuntimeToolsToken(createRuntimeToolsToken({ ...base, maxTtlSeconds: 12.5 })!.token, "github_credentials")!;
    expect(claims.exp - now).toBe(12);
  });
});
