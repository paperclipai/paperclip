import { describe, expect, it } from "vitest";
import { toolInputValidationMessage } from "./tool-input-errors.js";

describe("schema-derived tool validation feedback", () => {
  it("includes expected constants, enum choices, types and missing fields", () => {
    const message = toolInputValidationMessage([
      { keyword: "const", schemaPath: "#/properties/payload/properties/version/const", params: { allowedValue: 1 }, message: "must be equal to constant" },
      { keyword: "enum", schemaPath: "#/properties/mode/enum", params: { allowedValues: ["single", "multi"] }, message: "must be equal to one of the allowed values" },
      { keyword: "type", schemaPath: "#/properties/payload/type", params: { type: "object" }, message: "must be object" },
      { keyword: "required", schemaPath: "#/then/properties/payload/anyOf/0/required", params: { missingProperty: "questionSet" }, message: "must have required property 'questionSet'" },
    ]);
    expect(message).toContain("/payload/version must be equal to constant (expected 1)");
    expect(message).toContain('/mode must be equal to one of the allowed values (expected one of "single", "multi")');
    expect(message).toContain("/payload must be object");
    expect(message).toContain("/payload must have required property 'questionSet'");
  });
  it("derives locations from the public schema instead of model-controlled property names or values", () => {
    const error = { keyword: "type", instancePath: "/secret-input-property", data: "secret-value",
      schemaPath: "#/properties/payload/additionalProperties/type", params: { type: "object" }, message: "must be object" };
    const message = toolInputValidationMessage([error]);
    expect(message).toBe("Invalid tool input: /payload must be object");
    expect(message).not.toContain("secret");
  });
  it("bounds repeated errors and large schema values without serializing nested objects", () => {
    const message = toolInputValidationMessage(Array.from({ length: 1000 }, () => ({ keyword: "enum", schemaPath: "#/properties/value/enum",
      params: { allowedValues: [...Array.from({ length: 100 }, (_, index) => `value-${index}-${"😀".repeat(200)}`), { private: "not serialized" }] },
      message: "must be equal to one of the allowed values" })));
    expect(Buffer.byteLength(message)).toBeLessThanOrEqual(2048);
    expect(message).not.toContain("value-99");
    expect(message).not.toContain("not serialized");
    expect(message).not.toContain("�");
    expect(toolInputValidationMessage([{ keyword: "const", schemaPath: "#/const", params: { allowedValue: { nested: "not serialized" } } }]))
      .toBe("Invalid tool input: / is invalid (expected object from the tool schema)");
  });
  it("retains a bounded failure when the validator has no error details", () => {
    expect(toolInputValidationMessage(null)).toBe("Invalid tool input.");
  });
});
