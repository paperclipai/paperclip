import { describe, expect, it } from "vitest";
import { parseStatusFilter } from "../services/issues.ts";

/**
 * Unit tests for the helper introduced in https://github.com/paperclipai/paperclip/issues/4628
 *
 * Express's default `qs` parser binds repeated query keys (`?status=todo&status=in_progress`)
 * to a `string[]`, but `services/issues.ts` previously called `.split(",")`
 * unconditionally and crashed with a 500. `parseStatusFilter` normalizes all
 * shapes the route can legitimately receive:
 *   - `undefined`
 *   - single string  (`?status=todo`)
 *   - comma-separated string (`?status=todo,in_progress`)
 *   - string array (`?status=todo&status=in_progress`)
 *   - mixed array+CSV (`?status=todo,in_progress&status=done`)
 */

describe("parseStatusFilter", () => {
  it("returns [] for undefined", () => {
    expect(parseStatusFilter(undefined)).toEqual([]);
  });

  it("returns [] for empty string", () => {
    expect(parseStatusFilter("")).toEqual([]);
  });

  it("returns single-element array for a single status", () => {
    expect(parseStatusFilter("todo")).toEqual(["todo"]);
  });

  it("splits comma-separated values (preserves prior CSV behavior)", () => {
    expect(parseStatusFilter("todo,in_progress,done")).toEqual([
      "todo",
      "in_progress",
      "done",
    ]);
  });

  it("accepts string[] from repeated query keys (the bug fix)", () => {
    expect(parseStatusFilter(["todo", "in_progress"])).toEqual([
      "todo",
      "in_progress",
    ]);
  });

  it("flattens mixed array + CSV (?status=todo,in_progress&status=done)", () => {
    expect(parseStatusFilter(["todo,in_progress", "done"])).toEqual([
      "todo",
      "in_progress",
      "done",
    ]);
  });

  it("trims surrounding whitespace", () => {
    expect(parseStatusFilter(" todo ")).toEqual(["todo"]);
    expect(parseStatusFilter(" todo , in_progress ")).toEqual(["todo", "in_progress"]);
  });

  it("filters out empty entries from trailing/extra commas", () => {
    expect(parseStatusFilter("todo,")).toEqual(["todo"]);
    expect(parseStatusFilter(",")).toEqual([]);
    expect(parseStatusFilter(",,todo,,")).toEqual(["todo"]);
  });

  it("does not mutate caller-supplied arrays", () => {
    const input: readonly string[] = ["todo", "in_progress"];
    const out = parseStatusFilter(input);
    expect(out).not.toBe(input);
    expect(input).toEqual(["todo", "in_progress"]);
  });

  it("handles hostile non-string entries inside an array via type-defensive guard", () => {
    // The TypeScript signature forbids this, but Express casts hide a lot at
    // runtime — confirm we don't throw if a stray non-string slips in.
    const out = parseStatusFilter([
      "todo",
      // @ts-expect-error intentional: simulate a route-layer cast slipping a non-string through
      42,
      "done",
    ]);
    expect(out).toEqual(["todo", "done"]);
  });
});
