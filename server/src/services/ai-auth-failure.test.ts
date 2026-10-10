import { describe, expect, it } from "vitest";
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
    ["opencode_local", { model: "paperclip/deepseek-flash" }, "deepseek"],
    ["opencode_local", { model: "openrouter/deepseek/deepseek-v4-flash-0731" }, "openrouter"],
    ["claude_local", { model: "deepseek-flash" }, "deepseek"],
    ["codex_local", { model: "deepseek-flash" }, "deepseek"],
    ["claude_local", { model: "claude-sonnet-4-5" }, "anthropic"],
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
});
