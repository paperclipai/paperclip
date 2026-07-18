import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SERVER_ONLY_SECRET_ENV_KEYS,
  __resetServerOnlySecretCaptureForTests,
  readServerOnlySecret,
  scrubServerOnlySecretsFromProcessEnv,
} from "../server-secret-env.js";
import { createLocalAgentJwt, verifyLocalAgentJwt } from "../agent-auth-jwt.js";

describe("server-only secret env scrub (ETR-35)", () => {
  const original = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of SERVER_ONLY_SECRET_ENV_KEYS) original.set(key, process.env[key]);
    __resetServerOnlySecretCaptureForTests();
  });

  afterEach(() => {
    __resetServerOnlySecretCaptureForTests();
    for (const key of SERVER_ONLY_SECRET_ENV_KEYS) {
      const value = original.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("removes signing secrets from process.env and serves them from capture", () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "scrub-test-secret";
    process.env.BETTER_AUTH_SECRET = "scrub-test-better-auth";
    process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET = "scrub-test-tool-action";

    scrubServerOnlySecretsFromProcessEnv();

    for (const key of SERVER_ONLY_SECRET_ENV_KEYS) {
      expect(process.env[key]).toBeUndefined();
    }
    expect(readServerOnlySecret("PAPERCLIP_AGENT_JWT_SECRET")).toBe("scrub-test-secret");
    expect(readServerOnlySecret("BETTER_AUTH_SECRET")).toBe("scrub-test-better-auth");
    expect(readServerOnlySecret("PAPERCLIP_TOOL_ACTION_SIGNING_SECRET")).toBe("scrub-test-tool-action");
  });

  it("keeps run JWT mint/verify working after the scrub", () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "scrub-test-secret";
    scrubServerOnlySecretsFromProcessEnv();

    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");
    expect(token).not.toBeNull();
    expect(verifyLocalAgentJwt(token!)).toMatchObject({ sub: "agent-1", run_id: "run-1" });
  });

  it("is idempotent and does not lose the captured value on a second scrub", () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "scrub-test-secret";
    scrubServerOnlySecretsFromProcessEnv();
    scrubServerOnlySecretsFromProcessEnv();
    expect(readServerOnlySecret("PAPERCLIP_AGENT_JWT_SECRET")).toBe("scrub-test-secret");
  });

  it("falls back to process.env when the scrub has not run (CLI/test contexts)", () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "fallback-secret";
    expect(readServerOnlySecret("PAPERCLIP_AGENT_JWT_SECRET")).toBe("fallback-secret");
  });
});
