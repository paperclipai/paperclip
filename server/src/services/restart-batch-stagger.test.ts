import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression coverage for the RENA-54203 review fix: an explicitly-configured
// `HEARTBEAT_RESTART_BATCH_STAGGER_MAX_MS=0` (operator disabling staggering)
// must survive env parsing as 0, not silently fall back to the 5-minute
// default. The constants are computed once at module load, so each case
// stubs env vars and re-imports the module fresh via vi.resetModules().
describe("restart-batch-stagger env parsing (RENA-54203)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("honors an explicit HEARTBEAT_RESTART_BATCH_STAGGER_MAX_MS=0 instead of defaulting to 5 minutes", async () => {
    vi.stubEnv("HEARTBEAT_RESTART_BATCH_STAGGER_MAX_MS", "0");
    const mod = await import("./restart-batch-stagger.js");
    expect(mod.RESTART_BATCH_PROCESS_LOSS_STAGGER_MAX_MS).toBe(0);
  });

  it("falls back to the 5-minute default when the env var is unset", async () => {
    vi.stubEnv("HEARTBEAT_RESTART_BATCH_STAGGER_MAX_MS", undefined);
    const mod = await import("./restart-batch-stagger.js");
    expect(mod.RESTART_BATCH_PROCESS_LOSS_STAGGER_MAX_MS).toBe(5 * 60 * 1000);
  });

  it("falls back to the 5-minute default when the env var is not a finite number", async () => {
    vi.stubEnv("HEARTBEAT_RESTART_BATCH_STAGGER_MAX_MS", "not-a-number");
    const mod = await import("./restart-batch-stagger.js");
    expect(mod.RESTART_BATCH_PROCESS_LOSS_STAGGER_MAX_MS).toBe(5 * 60 * 1000);
  });

  it("respects an explicit non-zero HEARTBEAT_RESTART_BATCH_STAGGER_MAX_MS override", async () => {
    vi.stubEnv("HEARTBEAT_RESTART_BATCH_STAGGER_MAX_MS", "12345");
    const mod = await import("./restart-batch-stagger.js");
    expect(mod.RESTART_BATCH_PROCESS_LOSS_STAGGER_MAX_MS).toBe(12345);
  });

  it("falls back to the default reap threshold of 8 when unset, and honors an explicit override", async () => {
    vi.stubEnv("HEARTBEAT_RESTART_BATCH_REAP_THRESHOLD", undefined);
    const defaultMod = await import("./restart-batch-stagger.js");
    expect(defaultMod.RESTART_BATCH_PROCESS_LOSS_REAP_THRESHOLD).toBe(8);

    vi.resetModules();
    vi.stubEnv("HEARTBEAT_RESTART_BATCH_REAP_THRESHOLD", "3");
    const overriddenMod = await import("./restart-batch-stagger.js");
    expect(overriddenMod.RESTART_BATCH_PROCESS_LOSS_REAP_THRESHOLD).toBe(3);
  });
});
