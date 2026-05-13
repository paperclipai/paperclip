import { describe, it, expect } from "vitest";
import { createExecutionTargetRegistry } from "./execution-target-registry.js";
import type { ExecutionTargetDriver } from "./execution-target-registry.js";

function fakeDriver(): ExecutionTargetDriver {
  return {
    type: "kubernetes",
    validateTarget: async () => {},
    ensureTenant: async () => ({ namespace: "x", ciliumApplied: false }),
    run: async () => ({ exitCode: 0, signal: null, timedOut: false }),
  };
}

describe("ExecutionTargetDriverRegistry", () => {
  it("registers and retrieves a driver by kind", () => {
    const reg = createExecutionTargetRegistry();
    const d = fakeDriver();
    reg.register(d);
    expect(reg.get("kubernetes")).toBe(d);
  });

  it("rejects duplicate registrations of the same kind", () => {
    const reg = createExecutionTargetRegistry();
    reg.register(fakeDriver());
    expect(() => reg.register(fakeDriver())).toThrow(/already registered/i);
  });

  it("returns null for unknown kinds", () => {
    const reg = createExecutionTargetRegistry();
    expect(reg.get("kubernetes")).toBeNull();
  });

  it("list() returns all registered drivers", () => {
    const reg = createExecutionTargetRegistry();
    const d = fakeDriver();
    reg.register(d);
    expect(reg.list()).toEqual([d]);
  });
});
