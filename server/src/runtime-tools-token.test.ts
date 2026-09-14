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
    })!;
    expect(verifyRuntimeToolsToken(`${minted.token.slice(0, -1)}x`)).toBeNull();
    vi.setSystemTime(new Date("2026-08-26T13:00:01.000Z"));
    expect(verifyRuntimeToolsToken(minted.token)).toBeNull();
  });
  it("bounds long-run service capabilities without widening connection or GitHub access", () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "test-runtime-tools-secret");
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "services-test");
    vi.setSystemTime(new Date("2026-09-12T12:00:00.000Z"));
    const minted = createRuntimeToolsToken({ agentId: "a", companyId: "c", runId: "r", responsibleUserId: "", scope: "runtime_services" })!;
    expect(verifyRuntimeToolsToken(minted.token)).toBeNull();
    expect(verifyRuntimeToolsToken(minted.token, "github_credentials")).toBeNull();
    expect(verifyRuntimeToolsToken(minted.token, "runtime_services")?.run_id).toBe("r");
    vi.setSystemTime(new Date("2026-09-13T12:00:00.000Z"));
    expect(verifyRuntimeToolsToken(minted.token, "runtime_services")).not.toBeNull();
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "other-instance");
    expect(verifyRuntimeToolsToken(minted.token, "runtime_services")).toBeNull();
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "services-test");
    vi.setSystemTime(new Date("2026-10-13T12:00:00.000Z"));
    expect(verifyRuntimeToolsToken(minted.token, "runtime_services")).toBeNull();
  });

});
