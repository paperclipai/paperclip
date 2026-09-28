// @vitest-environment node
import { describe, expect, it } from "vitest";
import { subscriptionLoginAdapterType, supportsSandboxDeviceLogin } from "./AiConnectionCredentialStep";

describe("subscription sign-in routing", () => {
  it("maps each subscription provider to its login harness", () => {
    expect(subscriptionLoginAdapterType("anthropic")).toBe("claude_local");
    expect(subscriptionLoginAdapterType("openai")).toBe("codex_local");
    expect(subscriptionLoginAdapterType("xai")).toBe("grok_local");
    expect(subscriptionLoginAdapterType("meta")).toBe("muse_local");
  });

  it("offers sandbox device login only for providers with a login harness", () => {
    expect(supportsSandboxDeviceLogin("meta")).toBe(true);
    expect(supportsSandboxDeviceLogin("xai")).toBe(true);
    expect(supportsSandboxDeviceLogin("openai")).toBe(true);
    expect(supportsSandboxDeviceLogin("anthropic")).toBe(true);
    expect(supportsSandboxDeviceLogin("openrouter")).toBe(false);
  });

  it("fails loudly for a provider without a subscription login", () => {
    expect(() => subscriptionLoginAdapterType("openrouter")).toThrow();
  });
});
