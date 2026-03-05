import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for createDb connection pool configuration.
 *
 * We can't test actual Postgres connections in unit tests, but we can
 * verify the option resolution logic: defaults, explicit overrides,
 * and environment variable fallbacks.
 */

// Replicate the option resolution logic from client.ts.
interface CreateDbOptions {
  maxConnections?: number;
  idleTimeoutSec?: number;
  connectTimeoutSec?: number;
}

function resolvePoolOptions(opts?: CreateDbOptions) {
  const envPoolMax = parseInt(process.env.PAPERCLIP_DB_POOL_MAX ?? "", 10);
  const envIdleTimeout = parseInt(process.env.PAPERCLIP_DB_IDLE_TIMEOUT ?? "", 10);
  const envConnectTimeout = parseInt(process.env.PAPERCLIP_DB_CONNECT_TIMEOUT ?? "", 10);

  return {
    max: opts?.maxConnections ?? (envPoolMax > 0 ? envPoolMax : 10),
    idle_timeout: opts?.idleTimeoutSec ?? (envIdleTimeout > 0 ? envIdleTimeout : 20),
    connect_timeout: opts?.connectTimeoutSec ?? (envConnectTimeout > 0 ? envConnectTimeout : 30),
  };
}

describe("connection pool options", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.PAPERCLIP_DB_POOL_MAX;
    delete process.env.PAPERCLIP_DB_IDLE_TIMEOUT;
    delete process.env.PAPERCLIP_DB_CONNECT_TIMEOUT;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("uses defaults when no options or env vars provided", () => {
    const result = resolvePoolOptions();
    expect(result).toEqual({ max: 10, idle_timeout: 20, connect_timeout: 30 });
  });

  it("explicit options override defaults", () => {
    const result = resolvePoolOptions({
      maxConnections: 25,
      idleTimeoutSec: 60,
      connectTimeoutSec: 10,
    });
    expect(result).toEqual({ max: 25, idle_timeout: 60, connect_timeout: 10 });
  });

  it("env vars override defaults when no explicit options", () => {
    process.env.PAPERCLIP_DB_POOL_MAX = "30";
    process.env.PAPERCLIP_DB_IDLE_TIMEOUT = "45";
    process.env.PAPERCLIP_DB_CONNECT_TIMEOUT = "15";

    const result = resolvePoolOptions();
    expect(result).toEqual({ max: 30, idle_timeout: 45, connect_timeout: 15 });
  });

  it("explicit options take precedence over env vars", () => {
    process.env.PAPERCLIP_DB_POOL_MAX = "30";

    const result = resolvePoolOptions({ maxConnections: 5 });
    expect(result.max).toBe(5);
  });

  it("ignores invalid env var values", () => {
    process.env.PAPERCLIP_DB_POOL_MAX = "not-a-number";
    process.env.PAPERCLIP_DB_IDLE_TIMEOUT = "-5";
    process.env.PAPERCLIP_DB_CONNECT_TIMEOUT = "0";

    const result = resolvePoolOptions();
    // NaN is not > 0, -5 is not > 0, 0 is not > 0 — all fall through to defaults.
    expect(result).toEqual({ max: 10, idle_timeout: 20, connect_timeout: 30 });
  });

  it("handles partial explicit options", () => {
    const result = resolvePoolOptions({ maxConnections: 50 });
    expect(result.max).toBe(50);
    expect(result.idle_timeout).toBe(20); // default
    expect(result.connect_timeout).toBe(30); // default
  });
});
