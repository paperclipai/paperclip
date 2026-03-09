import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import React from "react";
import {
  JsonSchemaForm,
  validateJsonSchemaForm,
  getDefaultValues,
  resolveType,
  labelFromKey,
  getDefaultForSchema,
  validateField,
  type JsonSchemaNode,
} from "./JsonSchemaForm";

// ---------------------------------------------------------------------------
// resolveType
// ---------------------------------------------------------------------------
describe("resolveType", () => {
  it("returns 'string' for { type: 'string' }", () => {
    expect(resolveType({ type: "string" })).toBe("string");
  });

  it("returns 'number' for { type: 'number' }", () => {
    expect(resolveType({ type: "number" })).toBe("number");
  });

  it("returns 'integer' for { type: 'integer' }", () => {
    expect(resolveType({ type: "integer" })).toBe("integer");
  });

  it("returns 'boolean' for { type: 'boolean' }", () => {
    expect(resolveType({ type: "boolean" })).toBe("boolean");
  });

  it("returns 'object' for { type: 'object' }", () => {
    expect(resolveType({ type: "object" })).toBe("object");
  });

  it("returns 'array' for { type: 'array' }", () => {
    expect(resolveType({ type: "array" })).toBe("array");
  });

  it("returns 'enum' when schema has enum", () => {
    expect(resolveType({ type: "string", enum: ["a", "b"] })).toBe("enum");
  });

  it("returns 'const' when schema has const", () => {
    expect(resolveType({ type: "string", const: "fixed" })).toBe("const");
  });

  it("returns 'secret-ref' when format is 'secret-ref'", () => {
    expect(resolveType({ type: "string", format: "secret-ref" })).toBe("secret-ref");
  });

  it("handles array types by picking the first non-null type", () => {
    expect(resolveType({ type: ["null", "string"] })).toBe("string");
    expect(resolveType({ type: ["number", "null"] })).toBe("number");
  });

  it("defaults to 'string' when no type specified", () => {
    expect(resolveType({})).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// labelFromKey
// ---------------------------------------------------------------------------
describe("labelFromKey", () => {
  it("uses schema title when available", () => {
    expect(labelFromKey("apiKey", { title: "API Key" })).toBe("API Key");
  });

  it("converts camelCase to Title Case", () => {
    expect(labelFromKey("apiKey", {})).toBe("Api Key");
  });

  it("converts snake_case to Title Case", () => {
    expect(labelFromKey("api_key", {})).toBe("Api Key");
  });

  it("converts kebab-case to Title Case", () => {
    expect(labelFromKey("api-key", {})).toBe("Api Key");
  });

  it("handles single word", () => {
    expect(labelFromKey("name", {})).toBe("Name");
  });

  it("handles complex camelCase", () => {
    expect(labelFromKey("baseUrlForApi", {})).toBe("Base Url For Api");
  });
});

// ---------------------------------------------------------------------------
// getDefaultForSchema
// ---------------------------------------------------------------------------
describe("getDefaultForSchema", () => {
  it("returns schema default when specified", () => {
    expect(getDefaultForSchema({ type: "string", default: "hello" })).toBe("hello");
  });

  it("returns empty string for string type", () => {
    expect(getDefaultForSchema({ type: "string" })).toBe("");
  });

  it("returns empty string for secret-ref", () => {
    expect(getDefaultForSchema({ type: "string", format: "secret-ref" })).toBe("");
  });

  it("returns 0 for number type (no minimum)", () => {
    expect(getDefaultForSchema({ type: "number" })).toBe(0);
  });

  it("returns minimum for number type with minimum", () => {
    expect(getDefaultForSchema({ type: "number", minimum: 5 })).toBe(5);
  });

  it("returns false for boolean type", () => {
    expect(getDefaultForSchema({ type: "boolean" })).toBe(false);
  });

  it("returns first enum value for enum type", () => {
    expect(getDefaultForSchema({ enum: ["a", "b", "c"] })).toBe("a");
  });

  it("returns empty array for array type", () => {
    expect(getDefaultForSchema({ type: "array", items: { type: "string" } })).toEqual([]);
  });

  it("returns populated object for object type with properties", () => {
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        name: { type: "string" },
        count: { type: "number" },
      },
    };
    expect(getDefaultForSchema(schema)).toEqual({ name: "", count: 0 });
  });

  it("returns empty object for object type without properties", () => {
    expect(getDefaultForSchema({ type: "object" })).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// validateField
// ---------------------------------------------------------------------------
describe("validateField", () => {
  // Required checks
  it("returns error for required empty string", () => {
    expect(validateField("", { type: "string" }, true)).toBe("This field is required");
  });

  it("returns error for required undefined", () => {
    expect(validateField(undefined, { type: "string" }, true)).toBe("This field is required");
  });

  it("returns error for required null", () => {
    expect(validateField(null, { type: "string" }, true)).toBe("This field is required");
  });

  it("returns null for non-required empty value", () => {
    expect(validateField("", { type: "string" }, false)).toBeNull();
  });

  // String constraints
  it("validates minLength", () => {
    expect(validateField("ab", { type: "string", minLength: 3 }, false)).toBe(
      "Must be at least 3 characters",
    );
    expect(validateField("abc", { type: "string", minLength: 3 }, false)).toBeNull();
  });

  it("validates maxLength", () => {
    expect(validateField("abcd", { type: "string", maxLength: 3 }, false)).toBe(
      "Must be at most 3 characters",
    );
    expect(validateField("abc", { type: "string", maxLength: 3 }, false)).toBeNull();
  });

  it("validates pattern", () => {
    expect(validateField("abc", { type: "string", pattern: "^\\d+$" }, false)).toBe(
      "Must match pattern: ^\\d+$",
    );
    expect(validateField("123", { type: "string", pattern: "^\\d+$" }, false)).toBeNull();
  });

  // Number constraints
  it("validates minimum", () => {
    expect(validateField(2, { type: "number", minimum: 5 }, false)).toBe("Must be at least 5");
    expect(validateField(5, { type: "number", minimum: 5 }, false)).toBeNull();
  });

  it("validates maximum", () => {
    expect(validateField(10, { type: "number", maximum: 5 }, false)).toBe("Must be at most 5");
    expect(validateField(5, { type: "number", maximum: 5 }, false)).toBeNull();
  });

  it("validates exclusiveMinimum", () => {
    expect(validateField(5, { type: "number", exclusiveMinimum: 5 }, false)).toBe(
      "Must be greater than 5",
    );
    expect(validateField(6, { type: "number", exclusiveMinimum: 5 }, false)).toBeNull();
  });

  it("validates exclusiveMaximum", () => {
    expect(validateField(5, { type: "number", exclusiveMaximum: 5 }, false)).toBe(
      "Must be less than 5",
    );
    expect(validateField(4, { type: "number", exclusiveMaximum: 5 }, false)).toBeNull();
  });

  it("validates integer type", () => {
    expect(validateField(5.5, { type: "integer" }, false)).toBe("Must be a whole number");
    expect(validateField(5, { type: "integer" }, false)).toBeNull();
  });

  it("validates multipleOf", () => {
    expect(validateField(7, { type: "number", multipleOf: 3 }, false)).toBe(
      "Must be a multiple of 3",
    );
    expect(validateField(9, { type: "number", multipleOf: 3 }, false)).toBeNull();
  });

  it("returns error for non-numeric value in number field", () => {
    expect(validateField("abc", { type: "number" }, false)).toBe("Must be a valid number");
  });

  // Array constraints
  it("validates minItems", () => {
    expect(validateField([], { type: "array", minItems: 1 }, false)).toBe(
      "Must have at least 1 items",
    );
    expect(validateField(["a"], { type: "array", minItems: 1 }, false)).toBeNull();
  });

  it("validates maxItems", () => {
    expect(validateField(["a", "b", "c"], { type: "array", maxItems: 2 }, false)).toBe(
      "Must have at most 2 items",
    );
    expect(validateField(["a", "b"], { type: "array", maxItems: 2 }, false)).toBeNull();
  });

  // Valid values
  it("returns null for valid string", () => {
    expect(validateField("hello", { type: "string" }, true)).toBeNull();
  });

  it("returns null for valid number", () => {
    expect(validateField(42, { type: "number", minimum: 0, maximum: 100 }, true)).toBeNull();
  });

  it("returns null for valid boolean", () => {
    expect(validateField(true, { type: "boolean" }, false)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateJsonSchemaForm
// ---------------------------------------------------------------------------
describe("validateJsonSchemaForm", () => {
  it("returns empty object for valid form", () => {
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        name: { type: "string" },
        count: { type: "number" },
      },
      required: ["name"],
    };
    const values = { name: "test", count: 5 };
    expect(validateJsonSchemaForm(schema, values)).toEqual({});
  });

  it("returns errors for missing required fields", () => {
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        name: { type: "string" },
        email: { type: "string" },
      },
      required: ["name", "email"],
    };
    const values = { name: "", email: "" };
    const errors = validateJsonSchemaForm(schema, values);
    expect(errors["/name"]).toBe("This field is required");
    expect(errors["/email"]).toBe("This field is required");
  });

  it("validates nested objects", () => {
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        connection: {
          type: "object",
          properties: {
            host: { type: "string", minLength: 1 },
            port: { type: "integer", minimum: 1, maximum: 65535 },
          },
          required: ["host"],
        },
      },
    };
    const values = {
      connection: { host: "", port: 99999 },
    };
    const errors = validateJsonSchemaForm(schema, values);
    expect(errors["/connection/host"]).toBe("This field is required");
    expect(errors["/connection/port"]).toBe("Must be at most 65535");
  });

  it("validates array items (scalars)", () => {
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: { type: "string", minLength: 2 },
        },
      },
    };
    const values = {
      tags: ["ok", "a"], // "a" is too short
    };
    const errors = validateJsonSchemaForm(schema, values);
    expect(errors["/tags/1"]).toBe("Must be at least 2 characters");
    expect(errors["/tags/0"]).toBeUndefined();
  });

  it("validates array items (objects)", () => {
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        users: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
            },
            required: ["name"],
          },
        },
      },
    };
    const values = {
      users: [{ name: "Alice" }, { name: "" }],
    };
    const errors = validateJsonSchemaForm(schema, values);
    expect(errors["/users/1/name"]).toBe("This field is required");
    expect(errors["/users/0/name"]).toBeUndefined();
  });

  it("validates secret-ref fields as strings", () => {
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        apiKey: { type: "string", format: "secret-ref", minLength: 10 },
      },
      required: ["apiKey"],
    };
    const values = { apiKey: "short" };
    const errors = validateJsonSchemaForm(schema, values);
    expect(errors["/apiKey"]).toBe("Must be at least 10 characters");
  });

  it("skips non-required empty fields", () => {
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        optional: { type: "string", minLength: 5 },
      },
    };
    const values = { optional: "" };
    expect(validateJsonSchemaForm(schema, values)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// getDefaultValues
// ---------------------------------------------------------------------------
describe("getDefaultValues", () => {
  it("returns defaults from schema", () => {
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        name: { type: "string", default: "My Plugin" },
        enabled: { type: "boolean", default: true },
        count: { type: "number", default: 10 },
      },
    };
    expect(getDefaultValues(schema)).toEqual({
      name: "My Plugin",
      enabled: true,
      count: 10,
    });
  });

  it("returns type-appropriate defaults when no default specified", () => {
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        name: { type: "string" },
        enabled: { type: "boolean" },
        count: { type: "number" },
        env: { enum: ["staging", "production"] },
      },
    };
    expect(getDefaultValues(schema)).toEqual({
      name: "",
      enabled: false,
      count: 0,
      env: "staging",
    });
  });

  it("returns empty object for schema with no properties", () => {
    expect(getDefaultValues({ type: "object" })).toEqual({});
  });

  it("handles complex schema with nested objects and arrays", () => {
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        connection: {
          type: "object",
          properties: {
            host: { type: "string", default: "localhost" },
            port: { type: "integer", default: 3000 },
          },
        },
        tags: { type: "array", items: { type: "string" } },
      },
    };
    const defaults = getDefaultValues(schema);
    expect(defaults.connection).toEqual({ host: "localhost", port: 3000 });
    expect(defaults.tags).toEqual([]);
  });
});

// ===========================================================================
// Component rendering tests
// ===========================================================================

describe("JsonSchemaForm (component rendering)", () => {
  afterEach(() => {
    cleanup();
  });

  // -------------------------------------------------------------------------
  // Empty / no-config state
  // -------------------------------------------------------------------------
  it("shows 'no configuration' message when schema has no properties", () => {
    const onChange = vi.fn();
    render(
      <JsonSchemaForm schema={{ type: "object" }} values={{}} onChange={onChange} />,
    );
    expect(screen.getByText(/no configuration options available/i)).toBeTruthy();
  });

  it("shows 'no configuration' message for empty properties object", () => {
    const onChange = vi.fn();
    render(
      <JsonSchemaForm
        schema={{ type: "object", properties: {} }}
        values={{}}
        onChange={onChange}
      />,
    );
    expect(screen.getByText(/no configuration options available/i)).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // String field rendering
  // -------------------------------------------------------------------------
  it("renders a text input for string fields", () => {
    const onChange = vi.fn();
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        baseUrl: { type: "string", description: "The base URL to connect to" },
      },
    };

    render(
      <JsonSchemaForm schema={schema} values={{ baseUrl: "https://example.com" }} onChange={onChange} />,
    );

    expect(screen.getByText("Base Url")).toBeTruthy();
    expect(screen.getByText("The base URL to connect to")).toBeTruthy();
    const input = screen.getByDisplayValue("https://example.com");
    expect(input).toBeTruthy();
    expect(input.getAttribute("type")).toBe("text");
  });

  it("uses schema title as label when provided", () => {
    const onChange = vi.fn();
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        apiEndpoint: { type: "string", title: "API Endpoint URL" },
      },
    };

    render(
      <JsonSchemaForm schema={schema} values={{ apiEndpoint: "" }} onChange={onChange} />,
    );

    expect(screen.getByText("API Endpoint URL")).toBeTruthy();
  });

  it("renders a textarea for string fields with format: textarea", () => {
    const onChange = vi.fn();
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        notes: { type: "string", format: "textarea" },
      },
    };

    render(
      <JsonSchemaForm schema={schema} values={{ notes: "some notes" }} onChange={onChange} />,
    );

    // Textarea should exist with the value
    const textarea = document.querySelector("textarea");
    expect(textarea).toBeTruthy();
    expect(textarea?.value).toBe("some notes");
  });

  it("renders a textarea for string fields with maxLength > 200", () => {
    const onChange = vi.fn();
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        description: { type: "string", maxLength: 500 },
      },
    };

    render(
      <JsonSchemaForm schema={schema} values={{ description: "" }} onChange={onChange} />,
    );

    const textarea = document.querySelector("textarea");
    expect(textarea).toBeTruthy();
  });

  it("calls onChange when a string field is typed into", () => {
    const onChange = vi.fn();
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        name: { type: "string" },
      },
    };

    render(
      <JsonSchemaForm schema={schema} values={{ name: "" }} onChange={onChange} />,
    );

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "hello" } });
    expect(onChange).toHaveBeenCalledWith({ name: "hello" });
  });

  // -------------------------------------------------------------------------
  // Number field rendering
  // -------------------------------------------------------------------------
  it("renders a number input for number fields", () => {
    const onChange = vi.fn();
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        syncInterval: { type: "integer", minimum: 1, maximum: 60, description: "Sync interval in minutes" },
      },
    };

    render(
      <JsonSchemaForm schema={schema} values={{ syncInterval: 15 }} onChange={onChange} />,
    );

    expect(screen.getByText("Sync Interval")).toBeTruthy();
    expect(screen.getByText("Sync interval in minutes")).toBeTruthy();
    const input = screen.getByDisplayValue("15");
    expect(input).toBeTruthy();
    expect(input.getAttribute("type")).toBe("number");
  });

  it("calls onChange with a number when number input changes", () => {
    const onChange = vi.fn();
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        count: { type: "number" },
      },
    };

    render(
      <JsonSchemaForm schema={schema} values={{ count: 5 }} onChange={onChange} />,
    );

    const input = screen.getByDisplayValue("5");
    fireEvent.change(input, { target: { value: "10" } });
    expect(onChange).toHaveBeenCalledWith({ count: 10 });
  });

  // -------------------------------------------------------------------------
  // Boolean field rendering
  // -------------------------------------------------------------------------
  it("renders a checkbox for boolean fields", () => {
    const onChange = vi.fn();
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        enabled: { type: "boolean", description: "Enable this feature" },
      },
    };

    render(
      <JsonSchemaForm schema={schema} values={{ enabled: true }} onChange={onChange} />,
    );

    expect(screen.getByText("Enabled")).toBeTruthy();
    expect(screen.getByText("Enable this feature")).toBeTruthy();
    // The checkbox is a role=checkbox element
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Secret-ref field rendering
  // -------------------------------------------------------------------------
  it("renders a password input for secret-ref fields", () => {
    const onChange = vi.fn();
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        apiKey: { type: "string", format: "secret-ref", description: "Your API key" },
      },
    };

    render(
      <JsonSchemaForm schema={schema} values={{ apiKey: "sk-1234" }} onChange={onChange} />,
    );

    expect(screen.getByText("Api Key")).toBeTruthy();
    const input = screen.getByDisplayValue("sk-1234");
    expect(input).toBeTruthy();
    expect(input.getAttribute("type")).toBe("password");
  });

  it("shows default secret-ref description when none provided", () => {
    const onChange = vi.fn();
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        token: { type: "string", format: "secret-ref" },
      },
    };

    render(
      <JsonSchemaForm schema={schema} values={{ token: "" }} onChange={onChange} />,
    );

    expect(screen.getByText(/stored securely via the Paperclip secret provider/)).toBeTruthy();
  });

  it("toggles secret-ref visibility when eye button is clicked", () => {
    const onChange = vi.fn();
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        apiKey: { type: "string", format: "secret-ref" },
      },
    };

    render(
      <JsonSchemaForm schema={schema} values={{ apiKey: "my-secret" }} onChange={onChange} />,
    );

    const input = screen.getByDisplayValue("my-secret");
    expect(input.getAttribute("type")).toBe("password");

    // Click the "Show secret" button
    const revealBtn = screen.getByRole("button", { name: /show secret/i });
    fireEvent.click(revealBtn);

    // Now should be text
    expect(input.getAttribute("type")).toBe("text");

    // Button label changes
    const hideBtn = screen.getByRole("button", { name: /hide secret/i });
    expect(hideBtn).toBeTruthy();

    // Click again to hide
    fireEvent.click(hideBtn);
    expect(input.getAttribute("type")).toBe("password");
  });

  // -------------------------------------------------------------------------
  // Enum / Select field rendering
  // -------------------------------------------------------------------------
  it("renders a select for enum fields", () => {
    const onChange = vi.fn();
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        environment: { type: "string", enum: ["staging", "production"], description: "Target environment" },
      },
    };

    render(
      <JsonSchemaForm schema={schema} values={{ environment: "staging" }} onChange={onChange} />,
    );

    expect(screen.getByText("Environment")).toBeTruthy();
    expect(screen.getByText("Target environment")).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Required field indicator
  // -------------------------------------------------------------------------
  it("shows asterisk for required fields", () => {
    const onChange = vi.fn();
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        requiredField: { type: "string" },
        optionalField: { type: "string" },
      },
      required: ["requiredField"],
    };

    render(
      <JsonSchemaForm schema={schema} values={{ requiredField: "", optionalField: "" }} onChange={onChange} />,
    );

    // The required indicator (*) should appear
    const asterisks = document.querySelectorAll(".text-destructive");
    expect(asterisks.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // Validation error display
  // -------------------------------------------------------------------------
  it("displays validation error messages", () => {
    const onChange = vi.fn();
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        apiKey: { type: "string", format: "secret-ref" },
        baseUrl: { type: "string" },
      },
      required: ["apiKey", "baseUrl"],
    };

    const errors: Record<string, string> = {
      "/apiKey": "This field is required",
      "/baseUrl": "Must be at least 5 characters",
    };

    render(
      <JsonSchemaForm
        schema={schema}
        values={{ apiKey: "", baseUrl: "ab" }}
        onChange={onChange}
        errors={errors}
      />,
    );

    expect(screen.getByText("This field is required")).toBeTruthy();
    expect(screen.getByText("Must be at least 5 characters")).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Disabled state
  // -------------------------------------------------------------------------
  it("disables all fields when disabled prop is true", () => {
    const onChange = vi.fn();
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        name: { type: "string" },
        count: { type: "number" },
        enabled: { type: "boolean" },
      },
    };

    render(
      <JsonSchemaForm
        schema={schema}
        values={{ name: "test", count: 5, enabled: false }}
        onChange={onChange}
        disabled={true}
      />,
    );

    // Check text input is disabled
    const textInput = screen.getByDisplayValue("test");
    expect(textInput.hasAttribute("disabled")).toBe(true);

    // Check number input is disabled
    const numberInput = screen.getByDisplayValue("5");
    expect(numberInput.hasAttribute("disabled")).toBe(true);

    // Check checkbox is disabled
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox.hasAttribute("disabled") || checkbox.getAttribute("data-disabled") !== null).toBe(true);
  });

  it("disables readOnly fields even without disabled prop", () => {
    const onChange = vi.fn();
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        readOnlyField: { type: "string", readOnly: true },
      },
    };

    render(
      <JsonSchemaForm
        schema={schema}
        values={{ readOnlyField: "immutable" }}
        onChange={onChange}
      />,
    );

    const input = screen.getByDisplayValue("immutable");
    expect(input.hasAttribute("disabled")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Array field rendering
  // -------------------------------------------------------------------------
  it("renders array fields with add and remove buttons", () => {
    const onChange = vi.fn();
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: { type: "string" },
          description: "List of tags",
        },
      },
    };

    render(
      <JsonSchemaForm
        schema={schema}
        values={{ tags: ["alpha", "beta"] }}
        onChange={onChange}
      />,
    );

    expect(screen.getByText("Tags")).toBeTruthy();
    expect(screen.getByText("List of tags")).toBeTruthy();
    expect(screen.getByDisplayValue("alpha")).toBeTruthy();
    expect(screen.getByDisplayValue("beta")).toBeTruthy();

    // Add button
    expect(screen.getByRole("button", { name: /add/i })).toBeTruthy();
    // Remove buttons (one per item)
    const removeButtons = screen.getAllByRole("button", { name: /remove item/i });
    expect(removeButtons.length).toBe(2);
  });

  it("calls onChange when Add button is clicked in array field", () => {
    const onChange = vi.fn();
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: { type: "string" },
        },
      },
    };

    render(
      <JsonSchemaForm
        schema={schema}
        values={{ tags: ["one"] }}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /add/i }));
    // Should add a new empty string item
    expect(onChange).toHaveBeenCalledWith({ tags: ["one", ""] });
  });

  it("calls onChange when Remove button is clicked in array field", () => {
    const onChange = vi.fn();
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: { type: "string" },
        },
      },
    };

    render(
      <JsonSchemaForm
        schema={schema}
        values={{ tags: ["alpha", "beta"] }}
        onChange={onChange}
      />,
    );

    const removeButtons = screen.getAllByRole("button", { name: /remove item/i });
    fireEvent.click(removeButtons[0]);
    // Should remove first item
    expect(onChange).toHaveBeenCalledWith({ tags: ["beta"] });
  });

  it("disables Add button when maxItems is reached", () => {
    const onChange = vi.fn();
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: { type: "string" },
          maxItems: 2,
        },
      },
    };

    render(
      <JsonSchemaForm
        schema={schema}
        values={{ tags: ["one", "two"] }}
        onChange={onChange}
      />,
    );

    const addBtn = screen.getByRole("button", { name: /add/i });
    expect(addBtn.hasAttribute("disabled")).toBe(true);
  });

  it("disables Remove buttons when minItems is reached", () => {
    const onChange = vi.fn();
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
      },
    };

    render(
      <JsonSchemaForm
        schema={schema}
        values={{ tags: ["only-one"] }}
        onChange={onChange}
      />,
    );

    const removeButtons = screen.getAllByRole("button", { name: /remove item/i });
    expect(removeButtons[0].hasAttribute("disabled")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Nested object field rendering
  // -------------------------------------------------------------------------
  it("renders nested object fields as collapsible sections", () => {
    const onChange = vi.fn();
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        connection: {
          type: "object",
          properties: {
            host: { type: "string" },
            port: { type: "integer" },
          },
          description: "Database connection settings",
        },
      },
    };

    render(
      <JsonSchemaForm
        schema={schema}
        values={{ connection: { host: "localhost", port: 5432 } }}
        onChange={onChange}
      />,
    );

    // The object label should be rendered as a toggle button
    expect(screen.getByText("Connection")).toBeTruthy();
    expect(screen.getByText("Database connection settings")).toBeTruthy();
    // Nested fields should be visible (not collapsed by default)
    expect(screen.getByDisplayValue("localhost")).toBeTruthy();
    expect(screen.getByDisplayValue("5432")).toBeTruthy();
  });

  it("collapses nested object fields when toggle is clicked", () => {
    const onChange = vi.fn();
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        connection: {
          type: "object",
          properties: {
            host: { type: "string" },
          },
        },
      },
    };

    render(
      <JsonSchemaForm
        schema={schema}
        values={{ connection: { host: "localhost" } }}
        onChange={onChange}
      />,
    );

    // Nested field should be visible initially
    expect(screen.getByDisplayValue("localhost")).toBeTruthy();

    // Click the object label to collapse
    fireEvent.click(screen.getByText("Connection"));

    // Nested field should no longer be visible
    expect(screen.queryByDisplayValue("localhost")).toBeNull();

    // Click again to expand
    fireEvent.click(screen.getByText("Connection"));
    expect(screen.getByDisplayValue("localhost")).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Complex multi-field schema
  // -------------------------------------------------------------------------
  it("renders a complex schema with mixed field types", () => {
    const onChange = vi.fn();
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        apiKey: { type: "string", format: "secret-ref", title: "API Key" },
        baseUrl: { type: "string", title: "Base URL" },
        syncInterval: { type: "integer", title: "Sync Interval", minimum: 1, maximum: 60 },
        enabled: { type: "boolean", title: "Enabled" },
        environment: { type: "string", enum: ["staging", "production"], title: "Environment" },
      },
      required: ["apiKey", "baseUrl"],
    };

    render(
      <JsonSchemaForm
        schema={schema}
        values={{
          apiKey: "sk-test",
          baseUrl: "https://api.example.com",
          syncInterval: 15,
          enabled: true,
          environment: "staging",
        }}
        onChange={onChange}
      />,
    );

    // All labels should be present
    expect(screen.getByText("API Key")).toBeTruthy();
    expect(screen.getByText("Base URL")).toBeTruthy();
    expect(screen.getByText("Sync Interval")).toBeTruthy();
    expect(screen.getByText("Enabled")).toBeTruthy();
    expect(screen.getByText("Environment")).toBeTruthy();

    // Values should be rendered
    expect(screen.getByDisplayValue("sk-test")).toBeTruthy();
    expect(screen.getByDisplayValue("https://api.example.com")).toBeTruthy();
    expect(screen.getByDisplayValue("15")).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // aria-invalid attribute
  // -------------------------------------------------------------------------
  it("sets aria-invalid on fields with errors", () => {
    const onChange = vi.fn();
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        name: { type: "string" },
      },
    };

    render(
      <JsonSchemaForm
        schema={schema}
        values={{ name: "" }}
        onChange={onChange}
        errors={{ "/name": "This field is required" }}
      />,
    );

    const input = screen.getByRole("textbox");
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  // -------------------------------------------------------------------------
  // className prop
  // -------------------------------------------------------------------------
  it("applies custom className to the root container", () => {
    const onChange = vi.fn();
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        name: { type: "string" },
      },
    };

    const { container } = render(
      <JsonSchemaForm
        schema={schema}
        values={{ name: "" }}
        onChange={onChange}
        className="custom-class"
      />,
    );

    const rootDiv = container.firstElementChild;
    expect(rootDiv?.classList.contains("custom-class")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Array of objects (complex items)
  // -------------------------------------------------------------------------
  it("renders array of objects with item headers", () => {
    const onChange = vi.fn();
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        users: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              email: { type: "string" },
            },
            required: ["name"],
          },
        },
      },
    };

    render(
      <JsonSchemaForm
        schema={schema}
        values={{ users: [{ name: "Alice", email: "alice@test.com" }] }}
        onChange={onChange}
      />,
    );

    expect(screen.getByText("Users")).toBeTruthy();
    expect(screen.getByText("Item 1")).toBeTruthy();
    expect(screen.getByDisplayValue("Alice")).toBeTruthy();
    expect(screen.getByDisplayValue("alice@test.com")).toBeTruthy();
    // Add item button for complex arrays
    expect(screen.getByRole("button", { name: /add item/i })).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Placeholder from default
  // -------------------------------------------------------------------------
  it("uses schema default as placeholder when value is empty", () => {
    const onChange = vi.fn();
    const schema: JsonSchemaNode = {
      type: "object",
      properties: {
        hostname: { type: "string", default: "localhost" },
      },
    };

    render(
      <JsonSchemaForm
        schema={schema}
        values={{ hostname: "" }}
        onChange={onChange}
      />,
    );

    const input = screen.getByRole("textbox");
    expect(input.getAttribute("placeholder")).toBe("localhost");
  });
});
