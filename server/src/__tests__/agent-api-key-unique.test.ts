import { describe, expect, it } from "vitest";
import { isKeyHashUniqueViolation } from "../services/agents.ts";

describe("isKeyHashUniqueViolation", () => {
  it("returns true for 23505 on agent_api_keys_key_hash_idx", () => {
    const error = {
      code: "23505",
      constraint: "agent_api_keys_key_hash_idx",
    };
    expect(isKeyHashUniqueViolation(error)).toBe(true);
  });

  it("returns true when constraint is in constraint_name field", () => {
    const error = {
      code: "23505",
      constraint_name: "agent_api_keys_key_hash_idx",
    };
    expect(isKeyHashUniqueViolation(error)).toBe(true);
  });

  it("returns false for a different constraint", () => {
    const error = {
      code: "23505",
      constraint: "some_other_idx",
    };
    expect(isKeyHashUniqueViolation(error)).toBe(false);
  });

  it("returns false for a different error code", () => {
    const error = {
      code: "42P01",
      constraint: "agent_api_keys_key_hash_idx",
    };
    expect(isKeyHashUniqueViolation(error)).toBe(false);
  });

  it("returns false for null", () => {
    expect(isKeyHashUniqueViolation(null)).toBe(false);
  });

  it("returns false for non-object", () => {
    expect(isKeyHashUniqueViolation("some string")).toBe(false);
  });

  it("returns false when constraint fields are absent", () => {
    const error = { code: "23505" };
    expect(isKeyHashUniqueViolation(error)).toBe(false);
  });
});
