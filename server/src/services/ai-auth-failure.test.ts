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
  ] as const)("maps %s %j to %s", (adapter, config, provider) => {
    expect(aiBindingForAuthRecovery(adapter, config)).toMatchObject({ provider, mode: "responsible_user" });
  });
  it("does not guess a provider for unsupported harnesses or routes", () => {
    expect(aiBindingForAuthRecovery("gemini_local", {})).toBeUndefined();
    expect(aiBindingForAuthRecovery("opencode_local", { model: "anthropic/claude" })).toBeUndefined();
    expect(aiBindingForAuthRecovery("paperclip_runner", { provider: "acpx", acpxAgent: "custom" })).toBeUndefined();
  });
});
