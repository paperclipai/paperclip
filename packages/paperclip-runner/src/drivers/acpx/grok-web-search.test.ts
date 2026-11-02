import { describe, expect, it } from "vitest";
import { admittedGrokWebSearchPolicy, resolveGrokDisableWebSearch } from "./grok-web-search.js";

describe("Grok search policy", () => {
  it.each([undefined, true, false])("admits only the selected policy %s", selected => {
    expect(resolveGrokDisableWebSearch("grok", selected)).toBe(selected);
    expect(() => admittedGrokWebSearchPolicy("grok", selected, { grokDisableWebSearch: selected }, { grokDisableWebSearch: selected })).not.toThrow();
    expect(() => admittedGrokWebSearchPolicy("grok", selected, { grokDisableWebSearch: !selected }, { grokDisableWebSearch: selected })).toThrow("differs");
  });
  it("rejects malformed values and other providers before startup", () => {
    for (const value of [null, "true", 1]) expect(() => resolveGrokDisableWebSearch("grok", value)).toThrow("boolean");
    expect(() => resolveGrokDisableWebSearch("claude", true)).toThrow("Grok");
  });
});
