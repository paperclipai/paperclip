import { describe, expect, it } from "vitest";
import {
  pluginCgroupLimitsSchema,
  instanceExperimentalSettingsSchema,
  patchInstanceExperimentalSettingsSchema,
} from "./instance.js";

describe("pluginCgroupLimitsSchema", () => {
  it("accepts empty limits object", () => {
    expect(pluginCgroupLimitsSchema.parse({})).toEqual({});
  });

  it("accepts valid full limits", () => {
    const result = pluginCgroupLimitsSchema.parse({
      memoryHighBytes: 33554432,
      memoryMaxBytes: 67108864,
      cpuWeight: 100,
      pidsMax: 64,
    });
    expect(result.memoryHighBytes).toBe(33554432);
    expect(result.memoryMaxBytes).toBe(67108864);
    expect(result.cpuWeight).toBe(100);
    expect(result.pidsMax).toBe(64);
  });

  it("rejects memoryHighBytes below 32MB", () => {
    expect(() => pluginCgroupLimitsSchema.parse({ memoryHighBytes: 33554431 })).toThrow();
  });

  it("rejects memoryMaxBytes below 64MB", () => {
    expect(() => pluginCgroupLimitsSchema.parse({ memoryMaxBytes: 67108863 })).toThrow();
  });

  it("rejects cpuWeight below 1", () => {
    expect(() => pluginCgroupLimitsSchema.parse({ cpuWeight: 0 })).toThrow();
  });

  it("rejects cpuWeight above 10000", () => {
    expect(() => pluginCgroupLimitsSchema.parse({ cpuWeight: 10001 })).toThrow();
  });

  it("rejects pidsMax below 32", () => {
    expect(() => pluginCgroupLimitsSchema.parse({ pidsMax: 31 })).toThrow();
  });

  it("rejects pidsMax above 65536", () => {
    expect(() => pluginCgroupLimitsSchema.parse({ pidsMax: 65537 })).toThrow();
  });

  it("rejects memoryMaxBytes less than memoryHighBytes", () => {
    expect(() =>
      pluginCgroupLimitsSchema.parse({
        memoryHighBytes: 134217728,
        memoryMaxBytes: 67108864,
      }),
    ).toThrow();
  });

  it("rejects unknown keys (strict)", () => {
    expect(() => pluginCgroupLimitsSchema.parse({ unknownKey: 1 })).toThrow();
  });
});

describe("instanceExperimentalSettingsSchema — cgroup fields", () => {
  const base = {
    enableEnvironments: false,
    enableIsolatedWorkspaces: false,
    autoRestartDevServerWhenIdle: false,
    enableIssueGraphLivenessAutoRecovery: false,
    issueGraphLivenessAutoRecoveryLookbackHours: 24,
  };

  it("accepts default (no cgroup fields)", () => {
    const result = instanceExperimentalSettingsSchema.parse(base);
    expect(result.pluginCgroupDefaults).toEqual({});
    expect(result.pluginCgroupOverrides).toEqual({});
  });

  it("accepts valid pluginCgroupDefaults", () => {
    const result = instanceExperimentalSettingsSchema.parse({
      ...base,
      pluginCgroupDefaults: { pidsMax: 64 },
    });
    expect(result.pluginCgroupDefaults.pidsMax).toBe(64);
  });

  it("accepts valid pluginCgroupOverrides", () => {
    const result = instanceExperimentalSettingsSchema.parse({
      ...base,
      pluginCgroupOverrides: { "acme.linear-sync": { pidsMax: 128 } },
    });
    expect(result.pluginCgroupOverrides["acme.linear-sync"]?.pidsMax).toBe(128);
  });

  it("rejects override key with invalid plugin id format", () => {
    expect(() =>
      instanceExperimentalSettingsSchema.parse({
        ...base,
        pluginCgroupOverrides: { "INVALID_ID!": { pidsMax: 64 } },
      }),
    ).toThrow();
  });

  it("rejects single-char plugin id override key (must be ≥2 chars)", () => {
    expect(() =>
      instanceExperimentalSettingsSchema.parse({
        ...base,
        pluginCgroupOverrides: { "a": { pidsMax: 64 } },
      }),
    ).toThrow();
  });

  it("rejects override with invalid limit value", () => {
    expect(() =>
      instanceExperimentalSettingsSchema.parse({
        ...base,
        pluginCgroupOverrides: { "acme.test": { pidsMax: 1 } },
      }),
    ).toThrow();
  });
});

describe("patchInstanceExperimentalSettingsSchema — cgroup fields", () => {
  it("accepts partial patch with only cgroup defaults", () => {
    const result = patchInstanceExperimentalSettingsSchema.parse({
      pluginCgroupDefaults: { cpuWeight: 200 },
    });
    expect(result.pluginCgroupDefaults?.cpuWeight).toBe(200);
    expect(result.enableEnvironments).toBeUndefined();
  });
});
