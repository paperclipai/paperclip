import { describe, expect, it } from "vitest";
import { findServerAdapter, listServerAdapters } from "./registry.js";

describe("built-in adapter registry", () => {
  it("registers openai_compatible as a built-in adapter", () => {
    const adapter = findServerAdapter("openai_compatible");
    expect(adapter).not.toBeNull();
    expect(adapter?.type).toBe("openai_compatible");
    expect(listServerAdapters().map((candidate) => candidate.type)).toContain("openai_compatible");
  });
});
