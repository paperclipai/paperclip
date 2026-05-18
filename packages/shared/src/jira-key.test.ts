import { describe, expect, it } from "vitest";
import { extractJiraKey, extractAllJiraKeys } from "./jira-key.js";

describe("extractJiraKey", () => {
  it("extracts a standard Jira key from plain text", () => {
    expect(extractJiraKey("Fixes PD-123 in production")).toBe("PD-123");
  });

  it("extracts a 4-digit key", () => {
    expect(extractJiraKey("see PD-1234 for context")).toBe("PD-1234");
  });

  it("returns null when no key is present", () => {
    expect(extractJiraKey("no ticket referenced here")).toBeNull();
    expect(extractJiraKey("")).toBeNull();
  });

  it("returns the first key when multiple are present", () => {
    expect(extractJiraKey("PD-100 and PD-200 both apply")).toBe("PD-100");
  });

  it("does not match lowercase", () => {
    expect(extractJiraKey("pd-123 should not match")).toBeNull();
  });

  it("does not match keys that start with a digit", () => {
    expect(extractJiraKey("1AB-99 is not a valid key")).toBeNull();
  });

  it("does not match project prefixes longer than 10 chars", () => {
    expect(extractJiraKey("TOOLONGPREFIX-1 should not match")).toBeNull();
  });
});

describe("extractAllJiraKeys", () => {
  it("returns all unique keys in order", () => {
    expect(extractAllJiraKeys("PD-100 and PD-200 and PD-100 again")).toEqual(["PD-100", "PD-200"]);
  });

  it("returns empty array when no keys found", () => {
    expect(extractAllJiraKeys("nothing here")).toEqual([]);
  });
});
