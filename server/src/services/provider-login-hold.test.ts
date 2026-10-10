import { describe, expect, it } from "vitest";
import {
  decideProviderLoginHold,
  PROVIDER_LOGIN_HOLD_DEFAULTS,
  loginSettingsChanged,
  providerLoginLaneKey,
  type LaneRun,
} from "./provider-login-hold.js";

const config = PROVIDER_LOGIN_HOLD_DEFAULTS;
const now = new Date("2026-10-07T12:00:00Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
const authFailure = (minutes: number): LaneRun => ({ status: "failed", finishedAt: minutesAgo(minutes), errorCode: "claude_auth_required" });

describe("decideProviderLoginHold", () => {
  it("keeps the lane open without an authentication failure", () => {
    const runs: LaneRun[] = [
      { status: "failed", finishedAt: minutesAgo(1), errorCode: "adapter_failed" },
      { status: "succeeded", finishedAt: minutesAgo(2), errorCode: null },
    ];
    expect(decideProviderLoginHold(runs, now, config)).toEqual({ hold: false, reason: "lane_open" });
  });

  it("holds the lane after one authentication failure", () => {
    expect(decideProviderLoginHold([authFailure(1)], now, config)).toMatchObject({
      hold: true,
      reason: "login_failed",
      failures: 1,
      errorCode: "claude_auth_required",
      holdUntil: minutesAgo(-4),
    });
  });

  it("opens the lane when a run succeeds after the failure", () => {
    const runs: LaneRun[] = [{ status: "succeeded", finishedAt: minutesAgo(1), errorCode: null }, authFailure(2)];
    expect(decideProviderLoginHold(runs, now, config)).toEqual({ hold: false, reason: "lane_open" });
  });

  it("doubles the cooldown for each consecutive failure up to the cap", () => {
    expect(decideProviderLoginHold([authFailure(1), authFailure(10), authFailure(20)], now, config)).toMatchObject({
      hold: true,
      holdUntil: minutesAgo(1 - 20),
    });
    const many = Array.from({ length: 12 }, (_, index) => authFailure(1 + index));
    expect(decideProviderLoginHold(many, now, config)).toMatchObject({ hold: true, holdUntil: minutesAgo(1 - 60) });
  });

  it("releases exactly one probe after the cooldown", () => {
    const runs = [authFailure(6)];
    const first = decideProviderLoginHold(runs, now, config);
    expect(first).toEqual({ hold: false, reason: "probe_cooldown_elapsed", probe: true, failures: 1 });
    expect(decideProviderLoginHold(runs, now, config, { probe: { grantedAt: minutesAgo(0.5), finished: false } })).toMatchObject({
      hold: true,
      reason: "probe_in_flight",
    });
  });

  it("keeps the probe in flight when another run of the lane finishes first", () => {
    const runs: LaneRun[] = [{ status: "failed", finishedAt: minutesAgo(0.2), errorCode: "adapter_failed" }, authFailure(6)];
    expect(decideProviderLoginHold(runs, now, config, { probe: { grantedAt: minutesAgo(0.5), finished: false } })).toMatchObject({
      hold: true,
      reason: "probe_in_flight",
    });
    expect(decideProviderLoginHold(runs, now, config, { probe: { grantedAt: minutesAgo(0.5), finished: true } })).toMatchObject({
      hold: false,
      probe: true,
    });
  });

  it("releases a new probe when the previous probe timed out", () => {
    expect(decideProviderLoginHold([authFailure(30)], now, config, { probe: { grantedAt: minutesAgo(11), finished: false } })).toMatchObject({
      hold: false,
      probe: true,
    });
  });

  it("ignores failures outside the window", () => {
    expect(decideProviderLoginHold([authFailure(7 * 60)], now, config)).toEqual({ hold: false, reason: "lane_open" });
  });

  it("does nothing when disabled", () => {
    expect(decideProviderLoginHold([authFailure(1)], now, { ...config, disabled: true })).toEqual({ hold: false, reason: "disabled" });
  });
});

describe("providerLoginLaneKey", () => {
  const agent = (env: Record<string, unknown>, runtimeConfig: Record<string, unknown> = {}) => ({
    adapterType: "claude_local",
    adapterConfig: { model: "any", cwd: `/tmp/${Math.random()}`, env },
    runtimeConfig,
  });

  it("puts agents with the same login settings into one lane", () => {
    expect(providerLoginLaneKey(agent({ LOG_LEVEL: "debug" }))).toBe(providerLoginLaneKey(agent({})));
  });

  it("separates agents with another login directory, key, or AI connection", () => {
    const shared = providerLoginLaneKey(agent({}));
    expect(providerLoginLaneKey(agent({ CLAUDE_CONFIG_DIR: "/srv/other" }))).not.toBe(shared);
    expect(providerLoginLaneKey(agent({ ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "s1" } }))).not.toBe(shared);
    expect(providerLoginLaneKey(agent({}, { aiConnection: { provider: "anthropic", method: "api_key" } }))).not.toBe(shared);
    expect(providerLoginLaneKey({ ...agent({}), adapterType: "codex_local" })).not.toBe(shared);
  });
});

describe("loginSettingsChanged", () => {
  const snapshot = (env: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    adapterType: "claude_local", adapterConfig: { env, ...extra }, runtimeConfig: {},
  });

  it("detects a change of the login directory", () => {
    expect(loginSettingsChanged({ changedKeys: ["adapterConfig"], beforeConfig: snapshot({ CLAUDE_CONFIG_DIR: "/a" }), afterConfig: snapshot({ CLAUDE_CONFIG_DIR: "/b" }) })).toBe(true);
  });

  it("ignores edits that keep the login", () => {
    expect(loginSettingsChanged({ changedKeys: ["adapterConfig"], beforeConfig: snapshot({ CLAUDE_CONFIG_DIR: "/a" }, { model: "x" }), afterConfig: snapshot({ CLAUDE_CONFIG_DIR: "/a" }, { model: "y" }) })).toBe(false);
  });

  it("counts an adapter edit with a redacted credential as a login change", () => {
    const env = { ANTHROPIC_API_KEY: "***REDACTED***" };
    expect(loginSettingsChanged({ changedKeys: ["adapterConfig"], beforeConfig: snapshot(env), afterConfig: snapshot(env) })).toBe(true);
    expect(loginSettingsChanged({ changedKeys: ["name"], beforeConfig: snapshot(env), afterConfig: snapshot(env) })).toBe(false);
  });
});
