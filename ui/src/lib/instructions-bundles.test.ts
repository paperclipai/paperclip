import { describe, expect, it } from "vitest";
import { supportsInstructionsBundles } from "./instructions-bundles";

describe("supportsInstructionsBundles", () => {
  it("includes gemini_local in the local instructions-bundle adapters", () => {
    expect(supportsInstructionsBundles("gemini_local")).toBe(true);
  });

  it("rejects non-local adapters", () => {
    expect(supportsInstructionsBundles("http")).toBe(false);
    expect(supportsInstructionsBundles("process")).toBe(false);
  });
});
