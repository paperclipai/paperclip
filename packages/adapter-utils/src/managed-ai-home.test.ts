import { describe, expect, it } from "vitest";
import { managedAiHomeEnvironment, managedAiSessionEnvironment } from "./managed-ai-home.js";

describe("managed AI fingerprint environment", () => {
  it("normalizes exact server paths without changing the live environment", () => {
    const env = { ...managedAiHomeEnvironment("/tmp/first"), CUSTOM: "keep" };
    const original = { ...env };
    expect(managedAiSessionEnvironment(env, "/tmp/first")).toEqual(
      managedAiSessionEnvironment({ ...managedAiHomeEnvironment("/tmp/second"), CUSTOM: "keep" }, "/tmp/second"),
    );
    expect(env).toEqual(original);
  });
  it("preserves every custom home value and does nothing for unmanaged runs", () => {
    const custom = managedAiHomeEnvironment("/custom");
    expect(managedAiSessionEnvironment(custom, "/tmp/managed")).toEqual(custom);
    expect(managedAiSessionEnvironment(custom, undefined)).toBe(custom);
  });
});
