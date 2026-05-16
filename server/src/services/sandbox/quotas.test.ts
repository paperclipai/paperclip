import { describe, expect, it } from "vitest";
import {
  DEFAULT_SANDBOX_QUOTA_CEILINGS,
  InvalidSandboxQuotaError,
  MAX_SANDBOX_QUOTA_CEILINGS,
  parseSandboxQuotas,
} from "./quotas.js";

describe("sandbox quotas parser", () => {
  it("rejects undefined / null (unbounded)", () => {
    expect(() => parseSandboxQuotas(undefined)).toThrow(InvalidSandboxQuotaError);
    expect(() => parseSandboxQuotas(null)).toThrow(InvalidSandboxQuotaError);
  });

  it("rejects partial inputs missing required ceilings", () => {
    expect(() =>
      parseSandboxQuotas({ cpuMillis: 1_000, memoryBytes: 256 * 1024 * 1024 }),
    ).toThrow(InvalidSandboxQuotaError);
  });

  it("rejects zero / negative / non-integer values", () => {
    const base = { ...DEFAULT_SANDBOX_QUOTA_CEILINGS };
    expect(() => parseSandboxQuotas({ ...base, cpuMillis: 0 })).toThrow(InvalidSandboxQuotaError);
    expect(() => parseSandboxQuotas({ ...base, memoryBytes: -1 })).toThrow(InvalidSandboxQuotaError);
    expect(() => parseSandboxQuotas({ ...base, pidsLimit: 1.5 })).toThrow(InvalidSandboxQuotaError);
  });

  it("rejects values above the system maximum", () => {
    expect(() =>
      parseSandboxQuotas({
        ...DEFAULT_SANDBOX_QUOTA_CEILINGS,
        memoryBytes: MAX_SANDBOX_QUOTA_CEILINGS.memoryBytes + 1,
      }),
    ).toThrow(InvalidSandboxQuotaError);
  });

  it("accepts a safe explicit ceiling override", () => {
    const result = parseSandboxQuotas({
      cpuMillis: 1_000,
      memoryBytes: 512 * 1024 * 1024,
      pidsLimit: 128,
      ephemeralStorageBytes: 1 * 1024 * 1024 * 1024,
      walltimeSeconds: 600,
    });
    expect(result.cpuMillis).toBe(1_000);
    expect(result.memoryBytes).toBe(512 * 1024 * 1024);
    expect(result.walltimeSeconds).toBe(600);
  });

  it("rejects NaN/Infinity values", () => {
    expect(() =>
      parseSandboxQuotas({ ...DEFAULT_SANDBOX_QUOTA_CEILINGS, cpuMillis: Number.NaN }),
    ).toThrow(InvalidSandboxQuotaError);
    expect(() =>
      parseSandboxQuotas({ ...DEFAULT_SANDBOX_QUOTA_CEILINGS, memoryBytes: Number.POSITIVE_INFINITY }),
    ).toThrow(InvalidSandboxQuotaError);
  });
});
