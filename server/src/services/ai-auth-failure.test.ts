import { describe, expect, it } from "vitest";
import { aiConnectionMetadataSchema, aiRoutingHarness, isAiConnectionCompatible } from "@paperclipai/shared";
import { aiBindingForAuthRecovery, isAiAuthenticationFailure } from "./ai-auth-failure.js";

describe("AI authentication failure recovery", () => {
  it.each(["acpx_auth_required", "claude_auth_required", "codex_auth_required", "grok_auth_required", "adapter_auth_missing", "refresh_token_reused", "refresh_token_expired", "refresh_token_invalidated"])("recognizes %s", (code) => {
    expect(isAiAuthenticationFailure(code)).toBe(true);
  });
  it.each(["github_auth_required", "native_adopted_runner_authentication_timeout", "rate_limit", "adapter_failed", "permission_denied", undefined])("does not treat %s as model authentication", (code) => {
    expect(isAiAuthenticationFailure(code)).toBe(false);
  });
  it.each([
    ["codex_local", {}, "openai"],
    ["claude_local", {}, "anthropic"],
    ["paperclip_runner", { provider: "codex" }, "openai"],
    ["paperclip_runner", { provider: "acpx", acpxAgent: "claude" }, "anthropic"],
    ["paperclip_runner", { provider: "acpx", acpxAgent: "grok" }, "xai"],
    ["opencode_local", { model: "openrouter/model" }, "openrouter"],
  ] as const)("maps %s %j to %s", (adapter, config, provider) => {
    expect(aiBindingForAuthRecovery(adapter, config)).toMatchObject({ provider, mode: "responsible_user" });
  });
  it("does not guess a provider for unsupported harnesses or routes", () => {
    expect(aiBindingForAuthRecovery("opencode_local", { model: "anthropic/claude" })).toBeUndefined();
    expect(aiBindingForAuthRecovery("paperclip_runner", { provider: "acpx", acpxAgent: "custom" })).toBeUndefined();
  });
  it("offers Google's supported API-key method for Gemini recovery", () => {
    expect(aiBindingForAuthRecovery("gemini_local", {})).toEqual({ provider: "google", method: "api_key", mode: "responsible_user" });
  });
  it("offers Google subscription recovery for native Antigravity", () => {
    expect(aiBindingForAuthRecovery("paperclip_runner", { provider: "acpx", acpxAgent: "antigravity" }))
      .toEqual({ provider: "google", method: "subscription", mode: "responsible_user" });
  });
  it("offers an API key for a Google model in Pi", () => {
    expect(aiBindingForAuthRecovery("pi_local", { model: "google/fixture-model" }))
      .toEqual({ provider: "google", method: "api_key", mode: "responsible_user" });
  });
});


describe("native Antigravity account compatibility", () => {
  const compatible = (connection: Parameters<typeof isAiConnectionCompatible>[0]) =>
    isAiConnectionCompatible(connection, "paperclip_runner", "gemini-3.8-flash-low", "acpx", "antigravity");

  it.each(["api_key", "subscription"] as const)("accepts the selected Google %s account", method => {
    expect(aiRoutingHarness("paperclip_runner", "acpx", "antigravity")).toBe("antigravity_runtime");
    expect(compatible({ provider: "google", method })).toBe(true);
    expect(compatible({ provider: "google", method, mode: "responsible_user" })).toBe(true);
    expect(compatible({ provider: "google", method, mode: "delegated",
      connectionId: "11111111-1111-4111-8111-111111111111", grantId: "22222222-2222-4222-8222-222222222222" })).toBe(true);
  });

  it("rejects other providers, tool OAuth and API-compatible endpoints", () => {
    for (const provider of ["openai", "anthropic", "openrouter", "github", "xai"] as const) {
      expect(compatible({ provider, method: "api_key" })).toBe(false);
      expect(compatible({ provider, method: "api_key", mode: "shared",
        connectionId: "11111111-1111-4111-8111-111111111111", grantId: "22222222-2222-4222-8222-222222222222" })).toBe(false);
    }
    expect(aiConnectionMetadataSchema.safeParse({ provider: "google", method: "oauth" }).success).toBe(false);
    expect(compatible({ provider: "google", method: "api_key", routing: {
      kind: "openrouter", protocol: "chat", auth: "bearer", models: [],
    } })).toBe(false);
    expect(isAiConnectionCompatible({ provider: "google", method: "subscription" }, "gemini_local")).toBe(false);
  });
});
