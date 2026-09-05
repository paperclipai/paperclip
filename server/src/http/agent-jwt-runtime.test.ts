import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { createLocalAgentJwt, verifyLocalAgentJwt } from "../agent-auth-jwt.js";

describe("agent JWT under Bun", () => {
  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const originalTtl = process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;
  const originalInstance = process.env.PAPERCLIP_INSTANCE_ID;

  beforeEach(() => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "bun-runtime-secret";
    process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = "3600";
    delete process.env.PAPERCLIP_INSTANCE_ID;
    setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    setSystemTime();
    if (originalSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalSecret;
    if (originalTtl === undefined) delete process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;
    else process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = originalTtl;
    if (originalInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalInstance;
  });

  it("round-trips a signed agent JWT", () => {
    const token = createLocalAgentJwt(
      "agent-1",
      "company-1",
      "claude_local",
      "run-1",
      "user-1",
      { kind: "standard" },
    );

    expect(token).toBeString();
    expect(verifyLocalAgentJwt(token!)).toMatchObject({
      sub: "agent-1",
      company_id: "company-1",
      run_id: "run-1",
      responsible_user_id: "user-1",
      instance_id: "default",
    });
  });

  it("rejects an expired JWT", () => {
    process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = "1";
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");

    setSystemTime(new Date("2026-01-01T00:00:05.000Z"));
    expect(verifyLocalAgentJwt(token!)).toBeNull();
  });

  it("preserves a restricted key scope", () => {
    const token = createLocalAgentJwt(
      "agent-1",
      "company-1",
      "claude_local",
      "run-1",
      "user-1",
      { kind: "skill_test", issueId: "11111111-1111-4111-8111-111111111111" },
    );

    expect(verifyLocalAgentJwt(token!)?.key_scope).toEqual({
      kind: "skill_test",
      issueId: "11111111-1111-4111-8111-111111111111",
    });
  });
});
