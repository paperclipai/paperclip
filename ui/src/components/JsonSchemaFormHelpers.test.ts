import { describe, it, expect } from "vitest";
import {
  resolveType,
  labelFromKey,
  getDefaultForSchema,
  validateField,
  validateJsonSchemaForm,
  getDefaultValues,
  type JsonSchemaNode,
} from "./JsonSchemaForm";

describe("JsonSchemaForm Helpers (Unit)", () => {
  describe("resolveType", () => {
    it("identifies basic types correctly", () => {
      expect(resolveType({ type: "string" })).toBe("string");
      expect(resolveType({ type: "number" })).toBe("number");
      expect(resolveType({ type: "integer" })).toBe("integer");
      expect(resolveType({ type: "boolean" })).toBe("boolean");
      expect(resolveType({ type: "object" })).toBe("object");
      expect(resolveType({ type: "array" })).toBe("array");
    });

    it("identifies enum and const", () => {
      expect(resolveType({ enum: [1, 2] })).toBe("enum");
      expect(resolveType({ const: "value" })).toBe("const");
    });

    it("identifies secret-ref format", () => {
      expect(resolveType({ type: "string", format: "secret-ref" })).toBe("secret-ref");
    });

    it("handles union types by picking first non-null", () => {
      expect(resolveType({ type: ["null", "boolean"] })).toBe("boolean");
      expect(resolveType({ type: ["string", "null"] })).toBe("string");
      expect(resolveType({ type: ["null", "null"] })).toBe("string"); // fallback
    });

    it("defaults to string", () => {
      expect(resolveType({})).toBe("string");
    });
  });

  describe("labelFromKey", () => {
    it("prefers title if present", () => {
      expect(labelFromKey("testKey", { title: "Custom Title" })).toBe("Custom Title");
    });

    it("formats keys correctly", () => {
      expect(labelFromKey("camelCaseKey", {})).toBe("Camel Case Key");
      expect(labelFromKey("snake_case_key", {})).toBe("Snake Case Key");
      expect(labelFromKey("kebab-case-key", {})).toBe("Kebab Case Key");
    });
  });

  describe("getDefaultForSchema", () => {
    it("returns default value if provided", () => {
      expect(getDefaultForSchema({ default: "fallback" })).toBe("fallback");
    });

    it("returns appropriate zero-values for types", () => {
      expect(getDefaultForSchema({ type: "string" })).toBe("");
      expect(getDefaultForSchema({ type: "number", minimum: 5 })).toBe(5);
      expect(getDefaultForSchema({ type: "number" })).toBe(0);
      expect(getDefaultForSchema({ type: "boolean" })).toBe(false);
      expect(getDefaultForSchema({ type: "array" })).toEqual([]);
      expect(getDefaultForSchema({ type: "object" })).toEqual({});
    });

    it("recurses into objects", () => {
      const schema: JsonSchemaNode = {
        type: "object",
        properties: {
          name: { type: "string", default: "Alice" },
          age: { type: "number" },
        }
      };
      expect(getDefaultForSchema(schema)).toEqual({ name: "Alice", age: 0 });
    });

    it("handles enums by picking first value", () => {
      expect(getDefaultForSchema({ enum: ["a", "b"] })).toBe("a");
    });
  });

  describe("validateField", () => {
    it("checks required fields", () => {
      expect(validateField(undefined, { type: "string" }, true)).toBe("This field is required");
      expect(validateField("", { type: "string" }, true)).toBe("This field is required");
      expect(validateField("ok", { type: "string" }, true)).toBeNull();
    });

    it("skips empty non-required fields", () => {
      expect(validateField("", { type: "string", minLength: 5 }, false)).toBeNull();
    });

    it("validates string constraints", () => {
      const schema: JsonSchemaNode = { type: "string", minLength: 3, maxLength: 5, pattern: "^a" };
      expect(validateField("a", schema, false)).toBe("Must be at least 3 characters");
      expect(validateField("abcdef", schema, false)).toBe("Must be at most 5 characters");
      expect(validateField("bbb", schema, false)).toBe("Must match pattern: ^a");
      expect(validateField("abc", schema, false)).toBeNull();
    });

    it("validates number constraints", () => {
      const schema: JsonSchemaNode = { 
        type: "number", 
        minimum: 10, 
        maximum: 20,
        exclusiveMinimum: 10,
        exclusiveMaximum: 20
      };
      expect(validateField(10, schema, false)).toBe("Must be greater than 10");
      expect(validateField(20, schema, false)).toBe("Must be less than 20");
      expect(validateField(15, schema, false)).toBeNull();

      expect(validateField(11, { type: "integer", multipleOf: 2 }, false)).toBe("Must be a multiple of 2");
      expect(validateField(1.5, { type: "integer" }, false)).toBe("Must be a whole number");
    });

    it("validates array constraints", () => {
      const schema: JsonSchemaNode = { type: "array", minItems: 1, maxItems: 2 };
      expect(validateField([], schema, false)).toBe("Must have at least 1 items");
      expect(validateField([1, 2, 3], schema, false)).toBe("Must have at most 2 items");
    });
  });

  describe("validateJsonSchemaForm", () => {
    it("handles complex recursion with arrays and objects", () => {
      const schema: JsonSchemaNode = {
        type: "object",
        properties: {
          meta: {
            type: "object",
            properties: {
              id: { type: "string", minLength: 5 }
            }
          },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                val: { type: "number", minimum: 0 }
              },
              required: ["val"]
            }
          }
        }
      };

      const values = {
        meta: { id: "123" },
        items: [{ val: -1 }, { val: 10 }]
      };

      const errors = validateJsonSchemaForm(schema, values);
      expect(errors["/meta/id"]).toBe("Must be at least 5 characters");
      expect(errors["/items/0/val"]).toBe("Must be at least 0");
      expect(errors["/items/1/val"]).toBeUndefined();
    });
  });

  describe("getDefaultValues", () => {
    it("extracts all defaults from an object schema", () => {
      const schema: JsonSchemaNode = {
        type: "object",
        properties: {
          a: { type: "string", default: "hello" },
          b: { type: "number" },
          c: { 
            type: "object", 
            properties: { 
              d: { type: "boolean", default: true } 
            } 
          }
        }
      };
      expect(getDefaultValues(schema)).toEqual({
        a: "hello",
        b: 0,
        c: { d: true }
      });
    });
  });
});
