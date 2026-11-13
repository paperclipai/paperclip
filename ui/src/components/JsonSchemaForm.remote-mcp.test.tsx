// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonSchemaForm, validateJsonSchemaForm, type JsonSchemaNode } from "./JsonSchemaForm";
vi.mock("./SecretBindingPicker", () => ({ SecretBindingPicker: () => null }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const schema: JsonSchemaNode = { type: "object", properties: { tools: { type: "array", items: { type: "object", properties: { arguments: { type: "object", additionalProperties: true } } } } } };
let dispose: (() => void) | undefined;
afterEach(async () => { await act(async () => dispose?.()); document.body.innerHTML = ""; });
describe("remote MCP open-ended argument inputs", () => {
  it("edits nested tool arguments and rejects malformed JSON instead of submitting the previous object", async () => {
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container); dispose = () => root.unmount();
    let actual: Record<string, unknown> = {};
    function Form() {
      const [values, setValues] = useState({ tools: [{ arguments: {} }] } as Record<string, unknown>);
      actual = values;
      return <JsonSchemaForm schema={schema} values={values} onChange={setValues} />;
    }
    await act(async () => root.render(<Form />));
    const input = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Arguments JSON"]')!;
    expect(input).not.toBeNull();
    const fill = async (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await fill('{"repoName":"paperclipai/paperclip"}');
    expect(actual).toEqual({ tools: [{ arguments: { repoName: "paperclipai/paperclip" } }] });
    expect(validateJsonSchemaForm(schema, actual)).toEqual({});
    await fill('{"repoName":');
    expect(validateJsonSchemaForm(schema, actual)).toEqual({ "/tools/0/arguments": "Enter a valid JSON object" });
    await fill("[]");
    expect(validateJsonSchemaForm(schema, actual)["/tools/0/arguments"]).toBeTruthy();
    await fill("{}");
    expect(validateJsonSchemaForm(schema, actual)).toEqual({});
  });
  it("does not permit JSON null or array values for a required object", () => {
    const args: JsonSchemaNode = { type: "object", required: ["arguments"], properties: { arguments: { type: "object" } } };
    for (const value of [null, [], "broken"]) expect(Object.keys(validateJsonSchemaForm(args, { arguments: value }))).toHaveLength(1);
  });
});
