import { describe, expect, it } from "vitest";

import { applyLocalAgentJwtToEnv } from "./jwt-env.js";

// VIR-880 / VIR-881: thin unit coverage for the JWT env helper. The helper is
// pure (no I/O, no shared logger dependency) so the smoke stays deterministic
// and runs without the embedded Postgres harness.
//
// The previous version of this helper emitted a `jwt_env_race` telemetry event
// on every fresh first-time write, which produced false positives on every
// authenticated run (Greptile P1 review on PR #11333). Telemetry has been
// removed in favor of the heartbeat.ts typed-failure path; see jwt-env.ts for
// the full rationale.
describe("applyLocalAgentJwtToEnv (VIR-880 / VIR-881)", () => {
  it("writes parentAuthToken into env.PAPERCLIP_API_KEY when the child env was empty", () => {
    const env: Record<string, string> = { PAPERCLIP_RUN_ID: "run-1" };

    const result = applyLocalAgentJwtToEnv({
      env,
      parentAuthToken: "jwt-abc",
    });

    expect(result.previousHadToken).toBe(false);
    expect(result.appliedToken).toBe(true);
    expect(env.PAPERCLIP_API_KEY).toBe("jwt-abc");
  });

  it("overwrites an empty-string PAPERCLIP_API_KEY with the server-side token", () => {
    const env: Record<string, string> = { PAPERCLIP_API_KEY: "" };

    const result = applyLocalAgentJwtToEnv({
      env,
      parentAuthToken: "jwt-xyz",
    });

    expect(result.previousHadToken).toBe(false);
    expect(result.appliedToken).toBe(true);
    expect(env.PAPERCLIP_API_KEY).toBe("jwt-xyz");
  });

  it("is a no-op when parentAuthToken is null (server-side fail-fast handled in heartbeat)", () => {
    const env: Record<string, string> = { PAPERCLIP_RUN_ID: "run-3" };

    const result = applyLocalAgentJwtToEnv({
      env,
      parentAuthToken: null,
    });

    expect(result.previousHadToken).toBe(false);
    expect(result.appliedToken).toBe(false);
    expect(env.PAPERCLIP_API_KEY).toBeUndefined();
  });

  it("overwrites an existing JWT in env (idempotent re-application)", () => {
    const env: Record<string, string> = {
      PAPERCLIP_API_KEY: "stale-token-from-previous-spawn",
    };

    const result = applyLocalAgentJwtToEnv({
      env,
      parentAuthToken: "fresh-jwt",
    });

    expect(result.previousHadToken).toBe(true);
    expect(result.appliedToken).toBe(true);
    expect(env.PAPERCLIP_API_KEY).toBe("fresh-jwt");
  });

  it("does not mutate other env keys", () => {
    const env: Record<string, string> = {
      PAPERCLIP_RUN_ID: "run-5",
      PAPERCLIP_COMPANY_ID: "company-1",
    };

    applyLocalAgentJwtToEnv({
      env,
      parentAuthToken: "jwt-abc",
    });

    expect(env.PAPERCLIP_RUN_ID).toBe("run-5");
    expect(env.PAPERCLIP_COMPANY_ID).toBe("company-1");
    expect(env.PAPERCLIP_API_KEY).toBe("jwt-abc");
  });
});