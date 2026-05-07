import { describe, it, expect } from "vitest";
import { hasEligibleLabel } from "../src/label-gate.js";

describe("hasEligibleLabel", () => {
  it("accepts when label present", () => {
    expect(hasEligibleLabel([{ name: "agent-eligible" }, { name: "bug" }], "agent-eligible")).toBe(true);
  });
  it("rejects when label absent", () => {
    expect(hasEligibleLabel([{ name: "bug" }], "agent-eligible")).toBe(false);
  });
  it("rejects empty labels", () => {
    expect(hasEligibleLabel([], "agent-eligible")).toBe(false);
  });
  it("is case-sensitive", () => {
    expect(hasEligibleLabel([{ name: "Agent-Eligible" }], "agent-eligible")).toBe(false);
  });
});
