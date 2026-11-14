import { describe, expect, it } from "vitest";

import { resolveResultPromptInjectionModeFrom } from "../services/tool-gateway.js";

describe("resolveResultPromptInjectionModeFrom", () => {
  it("uses the configured ignore mode", () => {
    expect(resolveResultPromptInjectionModeFrom(() => ({ tools: { resultPromptInjectionMode: "ignore" } }))).toBe("ignore");
  });

  it("defaults to block when the tools config is omitted", () => {
    expect(resolveResultPromptInjectionModeFrom(() => ({}))).toBe("block");
    expect(resolveResultPromptInjectionModeFrom(() => null)).toBe("block");
  });

  it("falls back to block when the read throws", () => {
    expect(resolveResultPromptInjectionModeFrom(() => {
      throw new Error("read failed");
    })).toBe("block");
  });
});
