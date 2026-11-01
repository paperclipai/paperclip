import { describe, expect, it } from "vitest";
import { describeKimchiFailure, detectKimchiAuthRequired, isKimchiTransientNetworkError } from "./parse.js";

describe("describeKimchiFailure", () => {
  it("summarizes the first non-empty stderr detail", () => {
    expect(describeKimchiFailure({ errorMessage: null, stderr: "Error: kimchi boom\nsecond line" }))
      .toBe("Kimchi run failed: Error: kimchi boom");
  });

  it("prefers an explicit error message and returns null with no detail", () => {
    expect(describeKimchiFailure({ errorMessage: "  auth needed  ", stderr: "irrelevant" }))
      .toBe("Kimchi run failed: auth needed");
    expect(describeKimchiFailure({ errorMessage: null, stderr: "" })).toBeNull();
  });
});

describe("detectKimchiAuthRequired", () => {
  it("detects login prompts, 401s, and invalid api keys", () => {
    expect(detectKimchiAuthRequired({ stdout: "", stderr: "Not authenticated. Run `kimchi login`." }).requiresAuth).toBe(true);
    expect(detectKimchiAuthRequired({ stdout: "401 unauthorized", stderr: "" }).requiresAuth).toBe(true);
    expect(detectKimchiAuthRequired({ stdout: "", stderr: "invalid API key" }).requiresAuth).toBe(true);
  });

  it("does not flag ordinary failures", () => {
    expect(detectKimchiAuthRequired({ stdout: "compilation failed", stderr: "error: syntax" }).requiresAuth).toBe(false);
  });
});

describe("isKimchiTransientNetworkError", () => {
  it("detects transient network failures", () => {
    expect(isKimchiTransientNetworkError("", "fetch failed")).toBe(true);
    expect(isKimchiTransientNetworkError("socket hang up", "")).toBe(true);
    expect(isKimchiTransientNetworkError("", "permission denied")).toBe(false);
  });
});
