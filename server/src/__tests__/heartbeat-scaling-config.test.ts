import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

const ENV_KEYS = [
  "HEARTBEAT_MAX_CONCURRENT_ADAPTER_EXECUTIONS",
  "HEARTBEAT_TIMER_JITTER_MS",
] as const;

const originalEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const key of ENV_KEYS) {
    const original = originalEnv.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

describe("heartbeat scaling config", () => {
  it("defaults global adapter concurrency and timer jitter controls to disabled", () => {
    delete process.env.HEARTBEAT_MAX_CONCURRENT_ADAPTER_EXECUTIONS;
    delete process.env.HEARTBEAT_TIMER_JITTER_MS;

    const config = loadConfig();

    expect(config.heartbeatMaxConcurrentAdapterExecutions).toBe(0);
    expect(config.heartbeatTimerJitterMs).toBe(0);
  });

  it("parses non-negative heartbeat scaling controls from env", () => {
    process.env.HEARTBEAT_MAX_CONCURRENT_ADAPTER_EXECUTIONS = "7";
    process.env.HEARTBEAT_TIMER_JITTER_MS = "1250";

    const config = loadConfig();

    expect(config.heartbeatMaxConcurrentAdapterExecutions).toBe(7);
    expect(config.heartbeatTimerJitterMs).toBe(1250);
  });

  it("clamps negative heartbeat scaling controls to disabled", () => {
    process.env.HEARTBEAT_MAX_CONCURRENT_ADAPTER_EXECUTIONS = "-5";
    process.env.HEARTBEAT_TIMER_JITTER_MS = "-100";

    const config = loadConfig();

    expect(config.heartbeatMaxConcurrentAdapterExecutions).toBe(0);
    expect(config.heartbeatTimerJitterMs).toBe(0);
  });
});
