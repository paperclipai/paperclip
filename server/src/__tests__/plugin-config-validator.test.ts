import { describe, expect, it } from "vitest";
import { validateInstanceConfig } from "../services/plugin-config-validator.js";

describe("validateInstanceConfig", () => {
  it.each([
    { "x-paperclip-advanced": true },
    { "x-paperclip-group": "Connection" },
    { "x-paperclip-advanced": true, "x-paperclip-group": "Connection" },
  ])("validates configuration with UI annotations %j", (annotations) => {
    const schema = {
      type: "object",
      properties: {
        example: { type: "string", ...annotations },
      },
      required: ["example"],
    };

    expect(validateInstanceConfig({ example: "value" }, schema)).toEqual({ valid: true });
    expect(validateInstanceConfig({ example: 42 }, schema)).toEqual({
      valid: false,
      errors: [{ field: "/example", message: "must be string" }],
    });
    expect(validateInstanceConfig({}, schema).valid).toBe(false);
  });

  it("keeps rejecting unknown schema keywords", () => {
    expect(() => validateInstanceConfig({}, {
      type: "object",
      properties: { example: { type: "string", "x-paperclip-unknown": true } },
    })).toThrow();
  });

  it("preserves format validation and the secret-ref annotation", () => {
    const schema = {
      type: "object",
      properties: {
        email: { type: "string", format: "email" },
        secret: { type: "string", format: "secret-ref" },
      },
    };

    expect(validateInstanceConfig({ email: "user@example.com", secret: "reference" }, schema))
      .toEqual({ valid: true });
    expect(validateInstanceConfig({ email: "invalid" }, schema).valid).toBe(false);
  });
});
