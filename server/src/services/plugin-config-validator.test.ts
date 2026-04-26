import { describe, it, expect } from "vitest";
import { validateInstanceConfig } from "./plugin-config-validator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const stringSchema = {
  type: "object" as const,
  properties: { name: { type: "string" } },
  required: ["name"],
  additionalProperties: false,
};

const numberSchema = {
  type: "object" as const,
  properties: { count: { type: "number", minimum: 1, maximum: 100 } },
  required: ["count"],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// validateInstanceConfig
// ---------------------------------------------------------------------------

describe("validateInstanceConfig", () => {
  it("returns valid:true for a config that satisfies the schema", () => {
    const result = validateInstanceConfig({ name: "my-plugin" }, stringSchema);
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it("returns valid:false when a required field is missing", () => {
    const result = validateInstanceConfig({}, stringSchema);
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it("returns field path information in the error list", () => {
    const result = validateInstanceConfig({ count: "not-a-number" }, numberSchema);
    expect(result.valid).toBe(false);
    const fields = result.errors!.map((e) => e.field);
    // the path should reference the count property
    expect(fields.some((f) => f.includes("count") || f === "/")).toBe(true);
  });

  it("returns a non-empty message string for each error", () => {
    const result = validateInstanceConfig({}, stringSchema);
    expect(result.valid).toBe(false);
    result.errors!.forEach((e) => {
      expect(typeof e.message).toBe("string");
      expect(e.message.length).toBeGreaterThan(0);
    });
  });

  it("returns valid:false when an additional property is provided and additionalProperties is false", () => {
    const result = validateInstanceConfig({ name: "ok", extra: "bad" }, stringSchema);
    expect(result.valid).toBe(false);
  });

  it("returns valid:true for an empty config against an empty-required schema", () => {
    const emptySchema = { type: "object" as const, properties: {}, additionalProperties: false };
    const result = validateInstanceConfig({}, emptySchema);
    expect(result.valid).toBe(true);
  });

  it("validates numeric minimum constraint", () => {
    const result = validateInstanceConfig({ count: 0 }, numberSchema);
    expect(result.valid).toBe(false);
    expect(result.errors!.some((e) => e.field.includes("count") || e.field === "/count")).toBe(true);
  });

  it("validates numeric maximum constraint", () => {
    const result = validateInstanceConfig({ count: 101 }, numberSchema);
    expect(result.valid).toBe(false);
  });

  it("validates a valid number within range", () => {
    const result = validateInstanceConfig({ count: 50 }, numberSchema);
    expect(result.valid).toBe(true);
  });

  it("returns multiple errors when multiple fields are invalid", () => {
    const multiSchema = {
      type: "object" as const,
      properties: {
        a: { type: "string" },
        b: { type: "number" },
      },
      required: ["a", "b"],
    };
    const result = validateInstanceConfig({}, multiSchema);
    expect(result.valid).toBe(false);
    expect(result.errors!.length).toBeGreaterThanOrEqual(2);
  });

  it("validates enum constraints", () => {
    const enumSchema = {
      type: "object" as const,
      properties: { mode: { type: "string", enum: ["fast", "slow"] } },
      required: ["mode"],
    };
    const invalid = validateInstanceConfig({ mode: "medium" }, enumSchema);
    expect(invalid.valid).toBe(false);

    const valid = validateInstanceConfig({ mode: "fast" }, enumSchema);
    expect(valid.valid).toBe(true);
  });

  it("accepts the secret-ref format without error", () => {
    const secretRefSchema = {
      type: "object" as const,
      properties: { apiKey: { type: "string", format: "secret-ref" } },
      required: ["apiKey"],
    };
    const result = validateInstanceConfig({ apiKey: "any-uuid-value" }, secretRefSchema);
    expect(result.valid).toBe(true);
  });

  it("validates email format via ajv-formats", () => {
    const emailSchema = {
      type: "object" as const,
      properties: { email: { type: "string", format: "email" } },
      required: ["email"],
    };
    const invalid = validateInstanceConfig({ email: "not-an-email" }, emailSchema);
    expect(invalid.valid).toBe(false);

    const valid = validateInstanceConfig({ email: "user@example.com" }, emailSchema);
    expect(valid.valid).toBe(true);
  });
});
