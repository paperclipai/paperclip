import { describe, expect, it } from "vitest";
import { parseJsonNoDuplicateKeys } from "./strict-json.js";

describe("parseJsonNoDuplicateKeys", () => {
  it("parses ordinary JSON", () => {
    expect(parseJsonNoDuplicateKeys('{"a":1,"b":[true,null,"x"]}')).toEqual({
      a: 1,
      b: [true, null, "x"],
    });
  });

  it("rejects duplicate keys at the top level", () => {
    expect(() => parseJsonNoDuplicateKeys('{"op":"list","op":"expose"}')).toThrow(/duplicate/);
  });

  it("rejects duplicate keys nested in objects", () => {
    expect(() =>
      parseJsonNoDuplicateKeys('{"a":{"port":1,"port":2}}'),
    ).toThrow(/duplicate/);
  });

  it("does not pollute the prototype via __proto__", () => {
    const value = parseJsonNoDuplicateKeys('{"__proto__":{"polluted":true}}') as Record<
      string,
      unknown
    >;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(value, "__proto__")).toBe(true);
  });

  it("rejects trailing content and control characters in strings", () => {
    expect(() => parseJsonNoDuplicateKeys('{"a":1} extra')).toThrow();
    expect(() => parseJsonNoDuplicateKeys('{"a":"\n"}')).toThrow();
  });

  it("rejects non-canonical numbers", () => {
    expect(() => parseJsonNoDuplicateKeys("01")).toThrow();
  });
});
