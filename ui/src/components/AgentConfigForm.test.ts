import { describe, expect, it } from "vitest";
import { resolveExtraArgsValue } from "./AgentConfigForm";

describe("resolveExtraArgsValue", () => {
  it("parses comma-separated args", () => {
    expect(resolveExtraArgsValue(" --foo , --bar=baz , , --qux ")).toEqual([
      "--foo",
      "--bar=baz",
      "--qux",
    ]);
  });

  it("returns null for empty or whitespace-only values", () => {
    expect(resolveExtraArgsValue("")).toBeNull();
    expect(resolveExtraArgsValue("   ")).toBeNull();
  });
});
