import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeToolsToken, verifyRuntimeToolsToken } from "./runtime-tools-token.js";

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
      expiresAt: new Date("2026-08-26T16:00:00.000Z"),
    })!;
    expect(verifyRuntimeToolsToken(`${minted.token.slice(0, -1)}x`)).toBeNull();
    vi.setSystemTime(new Date("2026-08-26T13:20:00.000Z"));
    expect(verifyRuntimeToolsToken(minted.token)).not.toBeNull();
    vi.setSystemTime(new Date("2026-08-26T16:00:01.000Z"));
    expect(verifyRuntimeToolsToken(minted.token)).toBeNull();
  });

  it("uses the caller's bounded run expiry without extending other scopes", () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "test-runtime-tools-secret");
    vi.setSystemTime(new Date("2026-08-26T12:00:00.000Z"));
    const fields = { agentId: "agent-1", companyId: "company-1", runId: "run-1", responsibleUserId: "user-1" };
    const minted = createRuntimeToolsToken({
      ...fields,
      expiresAt: new Date("2026-08-26T18:15:00.000Z"),
    })!;
    expect(minted.expiresAt).toBe("2026-08-26T18:15:00.000Z");
    expect(() => createRuntimeToolsToken({ ...fields, expiresAt: new Date("2026-08-27T12:00:01.000Z") }))
      .toThrow("within 24 hours");
    expect(createRuntimeToolsToken({ ...fields, scope: "github_credentials" })!.expiresAt)
      .toBe("2026-09-25T12:00:00.000Z");
  });
});
