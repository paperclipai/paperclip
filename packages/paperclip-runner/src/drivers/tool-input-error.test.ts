import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it } from "vitest";
import { toolInputError } from "./tool-input-error.js";

it("leaves ordinary validation errors unchanged and excludes guidance from unrelated scopes", () => {
  const validate = new Ajv2020({ allErrors: true }).compile({ type: "object", required: ["id", "child"], properties: {
    id: { type: "string", description: "Root ID guidance" },
    child: { type: "object", required: ["id"], properties: { id: { type: "string", description: "Nested guidance" } } },
  } });
  validate({ id: 9, child: {} });
  expect(toolInputError(validate)).toBe("Invalid tool input: /id must be string; /child must have required property 'id'");
  expect(toolInputError(undefined)).toBe("Invalid tool input.");
});

it("bounds and deduplicates direct missing-property descriptions", () => {
  const properties = Object.fromEntries(["a", "b", "c", "d", "e"].map(key => [key, { type: "string", description: key === "b" ? "a".repeat(1100) : key.repeat(1100) }]));
  const validate = new Ajv2020({ allErrors: true }).compile({ type: "object", required: Object.keys(properties), properties });
  validate({});
  const result = toolInputError(validate);
  expect(result).toContain("a".repeat(1000));
  expect(result).toContain("c".repeat(1000));
  expect(result).toContain("d".repeat(1000));
  expect(result).not.toContain("e".repeat(1000));
  expect(result).not.toContain("a".repeat(1001));
});
