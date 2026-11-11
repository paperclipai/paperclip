// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonSchemaForm, type JsonSchemaNode } from "./JsonSchemaForm";

vi.mock("./SecretBindingPicker", () => ({ SecretBindingPicker: () => null }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let dispose: (() => void) | undefined;
afterEach(async () => {
  await act(async () => dispose?.());
  document.body.innerHTML = "";
});

describe("JsonSchemaForm string/object unions", () => {
  it.each<{
    name: string;
    schema: JsonSchemaNode;
    values: Record<string, unknown>;
    expected: Record<string, unknown>;
  }>([
    {
      name: "root",
      schema: { type: ["string", "object"] },
      values: { enabled: true },
      expected: { enabled: false },
    },
    {
      name: "array item",
      schema: { type: "object", properties: { configs: { type: "array", items: { type: ["string", "object"] } } } },
      values: { configs: [{ enabled: true }] },
      expected: { configs: [{ enabled: false }] },
    },
    {
      name: "nested property",
      schema: { type: "object", properties: { outer: { type: "object", properties: { config: { type: ["string", "object"] } } } } },
      values: { outer: { config: { enabled: true } } },
      expected: { outer: { config: { enabled: false } } },
    },
  ])("edits object unions at $name", async ({ schema, values, expected }) => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    dispose = () => root.unmount();
    const onChange = vi.fn();
    await act(async () => root.render(
      <JsonSchemaForm schema={schema} values={values} onChange={onChange} />,
    ));
    const input = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(input).not.toBeNull();
    expect(JSON.parse(input!.value)).toEqual({ enabled: true });
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, '{"enabled":false}');
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith(expected);
  });

  it.each([
    ["string", "object"],
    ["null", "string", "object"],
  ])("keeps object drafts in the JSON editor for %j", async (...types) => {
    const schema: JsonSchemaNode = {
      type: "object",
      properties: { config: { type: types } },
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    dispose = () => root.unmount();
    let actual: Record<string, unknown> = {};
    function Form() {
      const [values, setValues] = useState<Record<string, unknown>>({ config: { enabled: true } });
      actual = values;
      return <JsonSchemaForm schema={schema} values={values} onChange={setValues} />;
    }
    await act(async () => root.render(<Form />));
    const input = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(input).not.toBeNull();
    expect(JSON.parse(input!.value)).toEqual({ enabled: true });
    expect(container.querySelector("input")).toBeNull();
    const fill = async (text: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
        input!.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    await fill('{"enabled":false}');
    expect(actual).toEqual({ config: { enabled: false } });
    for (const text of ['"enabled":false}', "", "[]", "null", '"text"', "42", "false", "{"]) {
      await fill(text);
      expect(container.querySelector("textarea")).toBe(input);
      expect(input!.value).toBe(text);
      expect(input!.getAttribute("aria-invalid")).toBe("true");
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      expect(actual).toEqual({ config: { enabled: false } });
    }
    await fill('{"restored":true}');
    expect(actual).toEqual({ config: { restored: true } });
    expect(input!.getAttribute("aria-invalid")).toBe("false");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps string values in a text input", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    dispose = () => root.unmount();
    const onChange = vi.fn();
    await act(async () => root.render(
      <JsonSchemaForm
        schema={{ type: "object", properties: { config: { type: ["string", "object"] } } }}
        values={{ config: "saved text" }}
        onChange={onChange}
      />,
    ));
    const input = container.querySelector<HTMLInputElement>('input[type="text"]');
    expect(input?.value).toBe("saved text");
    expect(container.querySelector("textarea")).toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "edited text");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith({ config: "edited text" });
  });
});
