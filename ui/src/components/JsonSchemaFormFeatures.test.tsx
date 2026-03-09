import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { JsonSchemaForm, type JsonSchemaNode } from "./JsonSchemaForm";

describe("JsonSchemaForm Special Features", () => {
  describe("Root Scalar Rendering", () => {
    it("renders a root string schema", () => {
      const schema: JsonSchemaNode = { type: "string", title: "Global Key" };
      const onChange = vi.fn();
      render(<JsonSchemaForm schema={schema} values={"initial value" as any} onChange={onChange} />);
      
      const input = screen.getByRole("textbox");
      expect(input).toBeDefined();
      expect(input.getAttribute("value")).toBe("initial value");
      
      fireEvent.change(input, { target: { value: "new value" } });
      expect(onChange).toHaveBeenCalledWith("new value");
    });

    it("renders a root number schema", () => {
      const schema: JsonSchemaNode = { type: "number", title: "Global Count" };
      const onChange = vi.fn();
      render(<JsonSchemaForm schema={schema} values={10 as any} onChange={onChange} />);
      
      const input = screen.getByRole("spinbutton");
      expect(input).toBeDefined();
      expect(input.getAttribute("value")).toBe("10");
      
      fireEvent.change(input, { target: { value: "20" } });
      expect(onChange).toHaveBeenCalledWith(20);
    });

    it("renders a root boolean schema", () => {
      const schema: JsonSchemaNode = { type: "boolean", title: "Global Toggle" };
      const onChange = vi.fn();
      render(<JsonSchemaForm schema={schema} values={true as any} onChange={onChange} />);
      
      const checkbox = screen.getByRole("checkbox");
      expect(checkbox.getAttribute("aria-checked")).toBe("true");
      
      fireEvent.click(checkbox);
      expect(onChange).toHaveBeenCalledWith(false);
    });
  });

  describe("Deep Array Recursion", () => {
    it("renders and updates nested array items correctly", () => {
      const schema: JsonSchemaNode = {
        type: "object",
        properties: {
          teams: {
            type: "array",
            items: {
              type: "object",
              properties: {
                members: {
                  type: "array",
                  items: { type: "string" }
                }
              }
            }
          }
        }
      };
      
      const values = {
        teams: [
          { members: ["Alice", "Bob"] }
        ]
      };
      
      const onChange = vi.fn();
      render(<JsonSchemaForm schema={schema} values={values} onChange={onChange} />);
      
      expect(screen.getByDisplayValue("Alice")).toBeDefined();
      expect(screen.getByDisplayValue("Bob")).toBeDefined();
      
      const inputs = screen.getAllByRole("textbox");
      fireEvent.change(inputs[0], { target: { value: "Charlie" } });
      
      expect(onChange).toHaveBeenCalledWith({
        teams: [{ members: ["Charlie", "Bob"] }]
      });
    });
  });

  describe("Empty Object State", () => {
    it("shows fallback message for object with no properties", () => {
      const schema: JsonSchemaNode = { type: "object", properties: {} };
      render(<JsonSchemaForm schema={schema} values={{}} onChange={() => {}} />);
      
      expect(screen.getByText(/no configuration options available/i)).toBeDefined();
    });
  });
});
