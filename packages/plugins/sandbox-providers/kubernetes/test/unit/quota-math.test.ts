import { describe, expect, it } from "vitest";
import {
  defaultQuotaForPods,
  parseCpuMilli,
  parseMemoryBytes,
  podQuotaNeed,
} from "../../src/quota-math.js";

describe("quota arithmetic", () => {
  it("parses CPU and memory quantities", () => {
    expect(parseCpuMilli("2")).toBe(2000);
    expect(parseCpuMilli("250m")).toBe(250);
    expect(parseCpuMilli("1.5")).toBe(1500);
    expect(parseCpuMilli("lots")).toBeNaN();
    expect(parseMemoryBytes("4Gi")).toBe(4 * 1024 ** 3);
    expect(parseMemoryBytes("512Mi")).toBe(512 * 1024 ** 2);
    expect(parseMemoryBytes("1G")).toBe(1e9);
    expect(parseMemoryBytes(undefined)).toBeNaN();
  });

  it("derives a quota that admits every pod the cap allows (the 20 pod default is really 20 pods)", () => {
    const q = defaultQuotaForPods(20);
    expect(q).toEqual({ pods: "20", requestsCpu: "5", requestsMemory: "10Gi", limitsCpu: "40", limitsMemory: "80Gi" });
    const need = podQuotaNeed();
    // 20 default pods: limits 2 CPU / 4Gi each fit under the derived caps exactly.
    expect(20 * need.limitsCpuMilli).toBeLessThanOrEqual(parseCpuMilli(q.limitsCpu));
    expect(20 * need.limitsMemoryBytes).toBeLessThanOrEqual(parseMemoryBytes(q.limitsMemory));
    expect(20 * need.requestsCpuMilli).toBeLessThanOrEqual(parseCpuMilli(q.requestsCpu));
    expect(20 * need.requestsMemoryBytes).toBeLessThanOrEqual(parseMemoryBytes(q.requestsMemory));
    // The old default (limits.cpu 20) admitted only 10 of them.
    expect(Math.floor(20_000 / need.limitsCpuMilli)).toBe(10);
  });

  it("uses configured per-pod resources when present", () => {
    const need = podQuotaNeed({ limits: { cpu: "1", memory: "1Gi" }, requests: { cpu: "100m", memory: "128Mi" } });
    expect(need).toEqual({
      requestsCpuMilli: 100,
      requestsMemoryBytes: 128 * 1024 ** 2,
      limitsCpuMilli: 1000,
      limitsMemoryBytes: 1024 ** 3,
    });
  });
});
