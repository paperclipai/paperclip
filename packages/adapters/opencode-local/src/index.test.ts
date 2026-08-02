import { describe, expect, it } from "vitest";
import { buildOpenCodeModelProfiles, DEFAULT_OPENCODE_CHEAP_MODEL } from "./index.js";

describe("buildOpenCodeModelProfiles cheap lane", () => {
  it("defaults to the upstream Codex mini model with variant low", () => {
    const [cheap] = buildOpenCodeModelProfiles({});
    expect(cheap.key).toBe("cheap");
    expect(cheap.adapterConfig).toEqual({ model: DEFAULT_OPENCODE_CHEAP_MODEL, variant: "low" });
  });

  it("uses PAPERCLIP_OPENCODE_CHEAP_MODEL when set (no variant, gateway models may not support it)", () => {
    const [cheap] = buildOpenCodeModelProfiles({ PAPERCLIP_OPENCODE_CHEAP_MODEL: "anthropic/gw/m" });
    expect(cheap.adapterConfig).toEqual({ model: "anthropic/gw/m" });
  });

  it("falls back to PAPERCLIP_OPENCODE_SMALL_MODEL so one setting covers both budget lanes", () => {
    const [cheap] = buildOpenCodeModelProfiles({ PAPERCLIP_OPENCODE_SMALL_MODEL: "anthropic/gw/small" });
    expect(cheap.adapterConfig).toEqual({ model: "anthropic/gw/small" });
  });

  it("prefers CHEAP_MODEL over SMALL_MODEL when both are set", () => {
    const [cheap] = buildOpenCodeModelProfiles({
      PAPERCLIP_OPENCODE_CHEAP_MODEL: "anthropic/gw/cheap",
      PAPERCLIP_OPENCODE_SMALL_MODEL: "anthropic/gw/small",
    });
    expect(cheap.adapterConfig).toEqual({ model: "anthropic/gw/cheap" });
  });
});
