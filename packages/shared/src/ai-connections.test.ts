import { describe, expect, it } from "vitest";
import { AI_CONNECTION_CAPABILITIES, AI_PROVIDERS, aiProviderSchema, isAiConnectionCompatible } from "./ai-connections.js";

describe("meta (Muse) AI provider", () => {
  it("is a provider with subscription and api_key methods for muse_local via META_API_KEY", () => {
    expect(AI_PROVIDERS).toContain("meta");
    expect(aiProviderSchema.parse("meta")).toBe("meta");
    expect(AI_CONNECTION_CAPABILITIES.meta).toEqual({
      name: "Muse",
      methods: {
        subscription: { adapters: ["muse_local"], envKey: "META_API_KEY" },
        api_key: { adapters: ["muse_local"], envKey: "META_API_KEY" },
      },
    });
  });

  it("is compatible only with muse_local", () => {
    const binding = { provider: "meta", method: "subscription", mode: "responsible_user" } as const;
    expect(isAiConnectionCompatible(binding, "muse_local")).toBe(true);
    expect(isAiConnectionCompatible(binding, "grok_local")).toBe(false);
    expect(isAiConnectionCompatible({ provider: "meta", method: "api_key" }, "muse_local")).toBe(true);
  });
});
