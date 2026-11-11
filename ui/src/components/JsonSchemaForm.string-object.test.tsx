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

describe("string/object union fields", () => {
  it.each(["field", "nested", "array", "root"])("preserves object drafts in a %s", async (location) => {
    const union: JsonSchemaNode = { type: ["string", "object"] };
    const initial = { enabled: true };
    const schema: JsonSchemaNode = location === "root" ? union : {
      type: "object",
      properties: {
        config: location === "nested"
          ? { type: "object", properties: { payload: union } }
          : location === "array" ? { type: "array", items: union } : union,
      },
    };
    const initialValues = location === "root" ? initial : {
      config: location === "nested" ? { payload: initial } : location === "array" ? [initial] : initial,
    };
    let actual: Record<string, unknown> = initialValues;
    const onChange = vi.fn();
    function Form() {
      const [values, setValues] = useState<Record<string, unknown>>(initialValues);
      actual = values;
      return <JsonSchemaForm schema={schema} values={values} onChange={(next) => { onChange(next); setValues(next); }} />;
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    dispose = () => root.unmount();
    await act(async () => root.render(<Form />));
    const input = container.querySelector("textarea");
    expect(input).not.toBeNull();
    expect(input!.value).toBe(JSON.stringify(initial, null, 2));
    expect(container.querySelector('input[value="[object Object]"]')).toBeNull();
    const fill = async (text: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    for (const text of ['"enabled": true}', "", "[]", "null", '"string"', "42"]) {
      await fill(text);
      expect(container.querySelector("textarea")).toBe(input);
      expect(input!.value).toBe(text);
      expect(input!.getAttribute("aria-invalid")).toBe("true");
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      expect(actual).toEqual(initialValues);
      expect(onChange).not.toHaveBeenCalled();
    }
    await fill('{"enabled":false}');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(actual).toEqual(location === "root" ? { enabled: false } : {
      config: location === "nested" ? { payload: { enabled: false } } : location === "array" ? [{ enabled: false }] : { enabled: false },
    });
    expect(input!.getAttribute("aria-invalid")).toBe("false");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps string values in a text input", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    dispose = () => root.unmount();
    const onChange = vi.fn();
    await act(async () => root.render(<JsonSchemaForm
      schema={{ type: "object", properties: { config: { type: ["string", "object"] } } }}
      values={{ config: "original" }} onChange={onChange}
    />));
    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    expect(input.value).toBe("original");
    expect(container.querySelector("textarea")).toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "edited");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith({ config: "edited" });
  });
});
