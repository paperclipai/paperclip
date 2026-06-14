import { describe, expect, it } from "vitest";
import { isModelRouterEnabled } from "../services/model-router-signals.ts";

describe("isModelRouterEnabled", () => {
  it("is disabled by default (opt-in rollout)", () => {
    expect(isModelRouterEnabled({})).toBe(false);
  });
  it("enables when PAPERCLIP_MODEL_ROUTER=on", () => {
    expect(isModelRouterEnabled({ PAPERCLIP_MODEL_ROUTER: "on" })).toBe(true);
  });
  it("stays disabled for any other value", () => {
    expect(isModelRouterEnabled({ PAPERCLIP_MODEL_ROUTER: "off" })).toBe(false);
    expect(isModelRouterEnabled({ PAPERCLIP_MODEL_ROUTER: "1" })).toBe(false);
  });
});
