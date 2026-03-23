import { describe, it, expect } from "vitest";
import { stripNullBytes } from "../sanitize-postgres.js";

describe("stripNullBytes", () => {
  it("strips null bytes from strings", () => {
    expect(stripNullBytes("hello\x00world")).toBe("helloworld");
    expect(stripNullBytes("abc\x00\x00def")).toBe("abcdef");
    expect(stripNullBytes("\x00")).toBe("");
  });

  it("returns clean strings unchanged", () => {
    expect(stripNullBytes("hello world")).toBe("hello world");
    expect(stripNullBytes("")).toBe("");
  });

  it("passes through null and undefined", () => {
    expect(stripNullBytes(null)).toBe(null);
    expect(stripNullBytes(undefined)).toBe(undefined);
  });

  it("passes through numbers and booleans", () => {
    expect(stripNullBytes(42)).toBe(42);
    expect(stripNullBytes(true)).toBe(true);
  });

  it("preserves Date instances", () => {
    const date = new Date("2026-03-22T07:00:00.000Z");
    const result = stripNullBytes(date);
    expect(result).toBe(date);
    expect(result instanceof Date).toBe(true);
    expect(result.toISOString()).toBe("2026-03-22T07:00:00.000Z");
  });

  it("preserves Date instances inside objects", () => {
    const date = new Date("2026-03-22T07:00:00.000Z");
    const result = stripNullBytes({ finishedAt: date, error: "test\x00msg" });
    expect(result.finishedAt).toBe(date);
    expect(result.finishedAt instanceof Date).toBe(true);
    expect(result.error).toBe("testmsg");
  });

  it("recursively strips from objects", () => {
    expect(
      stripNullBytes({ a: "foo\x00bar", b: 123, c: null }),
    ).toEqual({ a: "foobar", b: 123, c: null });
  });

  it("recursively strips from nested objects", () => {
    expect(
      stripNullBytes({ outer: { inner: "x\x00y" } }),
    ).toEqual({ outer: { inner: "xy" } });
  });

  it("recursively strips from arrays", () => {
    expect(
      stripNullBytes(["a\x00b", "c\x00d"]),
    ).toEqual(["ab", "cd"]);
  });

  it("handles mixed nested structures", () => {
    const input = {
      messages: ["hello\x00", "world"],
      meta: { key: "val\x00ue", count: 5 },
      tags: [{ name: "t\x00ag" }],
    };
    expect(stripNullBytes(input)).toEqual({
      messages: ["hello", "world"],
      meta: { key: "value", count: 5 },
      tags: [{ name: "tag" }],
    });
  });
});
