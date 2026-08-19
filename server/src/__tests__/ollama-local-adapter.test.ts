import { describe, expect, it } from "vitest";
import { BUILTIN_ADAPTER_TYPES } from "../adapters/builtin-adapter-types.js";
import { findServerAdapter, listServerAdapters } from "../adapters/registry.js";

describe("ollama_local adapter registration", () => {
  it("is a selectable builtin with zero implicit agent assignment", () => {
    expect(BUILTIN_ADAPTER_TYPES.has("ollama_local")).toBe(true);
    expect(findServerAdapter("ollama_local")).toMatchObject({
      type: "ollama_local",
      supportsLocalAgentJwt: true,
    });
    expect(listServerAdapters().some((adapter) => adapter.type === "ollama_local")).toBe(true);
  });
});
