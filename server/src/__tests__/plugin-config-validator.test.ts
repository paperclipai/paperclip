import { describe, it, expect } from "vitest";
import { validateInstanceConfig } from "../services/plugin-config-validator.js";

describe("validateInstanceConfig", () => {
  it("returns valid=true for config that matches the schema", () => {
    const schema = {
      type: "object" as const,
      properties: { apiKey: { type: "string" } },
      required: ["apiKey"],
    };
    const result = validateInstanceConfig({ apiKey: "my-key" }, schema);
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it("returns valid=false when a required property is missing", () => {
    const schema = {
      type: "object" as const,
      properties: { apiKey: { type: "string" } },
      required: ["apiKey"],
    };
    const result = validateInstanceConfig({}, schema);
    expect(result.valid).toBe(false);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it("returns errors with field path and message", () => {
    const schema = {
      type: "object" as const,
      properties: { count: { type: "number" } },
      required: ["count"],
    };
    const result = validateInstanceConfig({ count: "not-a-number" }, schema);
    expect(result.valid).toBe(false);
    const err = result.errors![0];
    expect(err).toHaveProperty("field");
    expect(err).toHaveProperty("message");
  });

  it("returns valid=true for an empty config against an empty schema", () => {
    const result = validateInstanceConfig({}, { type: "object" as const, properties: {} });
    expect(result.valid).toBe(true);
  });

  it("validates string format constraints", () => {
    const schema = {
      type: "object" as const,
      properties: { email: { type: "string", format: "email" } },
      required: ["email"],
    };
    const valid = validateInstanceConfig({ email: "user@example.com" }, schema);
    expect(valid.valid).toBe(true);

    const invalid = validateInstanceConfig({ email: "not-an-email" }, schema);
    expect(invalid.valid).toBe(false);
  });

  it("collects all errors when multiple fields are invalid", () => {
    const schema = {
      type: "object" as const,
      properties: {
        a: { type: "string" },
        b: { type: "number" },
      },
      required: ["a", "b"],
    };
    const result = validateInstanceConfig({ a: 123, b: "wrong" }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors!.length).toBeGreaterThanOrEqual(2);
  });

  it("accepts a secret-ref format value without error", () => {
    const schema = {
      type: "object" as const,
      properties: {
        secretToken: { type: "string", format: "secret-ref" },
      },
      required: ["secretToken"],
    };
    // secret-ref is registered as always-valid; any string should pass
    const result = validateInstanceConfig({ secretToken: "some-uuid-value" }, schema);
    expect(result.valid).toBe(true);
  });

  it("uses '/' as field path when the error is at the root level", () => {
    const schema = { type: "array" as const };
    // Pass an object where the schema expects an array
    const result = validateInstanceConfig({} as never, schema as never);
    expect(result.valid).toBe(false);
    const rootError = result.errors!.find((e) => e.field === "/");
    expect(rootError).toBeDefined();
  });
});
