import { describe, it, expect } from "vitest";
import { renderBodyTemplate, extractByPath } from "../src/template.js";

describe("renderBodyTemplate", () => {
  it("replaces {{prompt}} in nested strings", () => {
    const tpl = { model: "gpt", messages: [{ role: "user", content: "say: {{prompt}}" }] };
    const out = renderBodyTemplate(tpl, { prompt: "hello" });
    expect(out).toEqual({ model: "gpt", messages: [{ role: "user", content: "say: hello" }] });
  });

  it("leaves non-string values untouched", () => {
    const tpl = { temperature: 0.5, streaming: false, n: null };
    const out = renderBodyTemplate(tpl, { prompt: "x" });
    expect(out).toEqual({ temperature: 0.5, streaming: false, n: null });
  });

  it("replaces multiple occurrences", () => {
    const out = renderBodyTemplate({ a: "{{prompt}}-{{prompt}}" }, { prompt: "y" });
    expect(out).toEqual({ a: "y-y" });
  });
});

describe("extractByPath", () => {
  it("extracts dot-path value", () => {
    const obj = { choices: [{ message: { content: "hi" } }] };
    expect(extractByPath(obj, "choices.0.message.content")).toBe("hi");
  });

  it("returns undefined on missing path", () => {
    expect(extractByPath({}, "a.b.c")).toBeUndefined();
  });

  it("throws when extracted value is not a string", () => {
    expect(() => extractByPath({ a: 1 }, "a")).toThrow(/not a string/);
  });
});
