import { describe, expect, it } from "vitest";
import { resolveExtraArgsValue } from "./AgentConfigForm";

describe("resolveExtraArgsValue", () => {
  it("parses comma-separated extra args", () => {
    expect(resolveExtraArgsValue("--verbose, --foo=bar")).toEqual([
      "--verbose",
      "--foo=bar",
    ]);
  });

  it("returns an empty array when the field is cleared", () => {
    expect(resolveExtraArgsValue("")).toEqual([]);
    expect(resolveExtraArgsValue("   ")).toEqual([]);
  });
});
