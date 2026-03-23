import { describe, expect, it } from "vitest";
import { parseShutdownDrainMsFromEnv } from "../shutdown-drain-ms.js";

describe("parseShutdownDrainMsFromEnv", () => {
  it("uses default when unset or empty", () => {
    expect(parseShutdownDrainMsFromEnv(undefined)).toBe(25000);
    expect(parseShutdownDrainMsFromEnv("")).toBe(25000);
    expect(parseShutdownDrainMsFromEnv("   ")).toBe(25000);
  });

  it("parses positive integers and clamps to max", () => {
    expect(parseShutdownDrainMsFromEnv("0")).toBe(0);
    expect(parseShutdownDrainMsFromEnv("5000")).toBe(5000);
    expect(parseShutdownDrainMsFromEnv("30000")).toBe(28000);
  });

  it("falls back on invalid values", () => {
    expect(parseShutdownDrainMsFromEnv("nan")).toBe(25000);
    expect(parseShutdownDrainMsFromEnv("-1")).toBe(25000);
  });
});
