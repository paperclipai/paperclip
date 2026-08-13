import { describe, expect, it } from "vitest";

import {
  JWT_ENV_RACE_ERROR_CODE,
  JWT_ENV_RACE_EVENT,
  applyLocalAgentJwtToEnv,
  type JwtEnvTelemetry,
} from "./jwt-env.js";

// VIR-880 / VIR-881: thin unit coverage for the JWT race helper. The helper is
// pure (no I/O, no shared logger dependency) so the smoke stays deterministic
// and runs without the embedded Postgres harness.
describe("applyLocalAgentJwtToEnv (VIR-880 / VIR-881)", () => {
  const fixedNow = () => new Date("2026-08-12T22:00:00.000Z");

  it("emits jwt_env_race telemetry when parentAuthToken is set but the child env was empty", () => {
    const env: Record<string, string> = { PAPERCLIP_RUN_ID: "run-1" };
    const events: JwtEnvTelemetry[] = [];

    const result = applyLocalAgentJwtToEnv({
      env,
      parentAuthToken: "jwt-abc",
      runId: "run-1",
      issueId: "VIR-881",
      agentId: "agent-1",
      adapterType: "opencode_local",
      onTelemetry: (event) => events.push(event),
      now: fixedNow,
    });

    expect(result.raced).toBe(true);
    expect(result.previousHadToken).toBe(false);
    expect(result.appliedToken).toBe(true);
    expect(env.PAPERCLIP_API_KEY).toBe("jwt-abc");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: "error",
      event: JWT_ENV_RACE_EVENT,
      errorCode: JWT_ENV_RACE_ERROR_CODE,
      timestamp: "2026-08-12T22:00:00.000Z",
      runId: "run-1",
      issueId: "VIR-881",
      agentId: "agent-1",
      adapterType: "opencode_local",
    });
    expect(events[0].message).toMatch(/PAPERCLIP_API_KEY estava vazio/);
  });

  it("treats an empty-string PAPERCLIP_API_KEY as the race condition and still overwrites with the server-side token", () => {
    const env: Record<string, string> = { PAPERCLIP_API_KEY: "" };
    const events: JwtEnvTelemetry[] = [];

    const result = applyLocalAgentJwtToEnv({
      env,
      parentAuthToken: "jwt-xyz",
      runId: null,
      issueId: null,
      agentId: null,
      adapterType: null,
      onTelemetry: (event) => events.push(event),
      now: fixedNow,
    });

    expect(result.raced).toBe(true);
    expect(result.previousHadToken).toBe(false);
    expect(env.PAPERCLIP_API_KEY).toBe("jwt-xyz");
    expect(events).toHaveLength(1);
    expect(events[0].errorCode).toBe(JWT_ENV_RACE_ERROR_CODE);
  });

  it("is a no-op when parentAuthToken is null (server-side fail-fast handled in heartbeat)", () => {
    const env: Record<string, string> = { PAPERCLIP_RUN_ID: "run-3" };
    const events: JwtEnvTelemetry[] = [];

    const result = applyLocalAgentJwtToEnv({
      env,
      parentAuthToken: null,
      runId: "run-3",
      issueId: "VIR-881",
      agentId: "agent-3",
      adapterType: "opencode_local",
      onTelemetry: (event) => events.push(event),
      now: fixedNow,
    });

    expect(result.raced).toBe(false);
    expect(result.appliedToken).toBe(false);
    expect(env.PAPERCLIP_API_KEY).toBeUndefined();
    expect(events).toHaveLength(0);
  });

  it("does not emit telemetry when the env already had a JWT (idempotent re-application)", () => {
    const env: Record<string, string> = {
      PAPERCLIP_API_KEY: "stale-token-from-previous-spawn",
    };
    const events: JwtEnvTelemetry[] = [];

    const result = applyLocalAgentJwtToEnv({
      env,
      parentAuthToken: "fresh-jwt",
      runId: "run-4",
      issueId: "VIR-881",
      agentId: "agent-4",
      adapterType: "opencode_local",
      onTelemetry: (event) => events.push(event),
      now: fixedNow,
    });

    expect(result.raced).toBe(false);
    expect(result.previousHadToken).toBe(true);
    expect(result.appliedToken).toBe(true);
    expect(env.PAPERCLIP_API_KEY).toBe("fresh-jwt");
    expect(events).toHaveLength(0);
  });
});
