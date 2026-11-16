import { describe, expect, it } from "vitest";
import { adapterUsesManagedAiConnection, isAiConnectionCompatible } from "./ai-connections.js";

describe("adapterUsesManagedAiConnection", () => {
  it("keeps managed bindings for capability-backed adapters", () => {
    for (const adapter of [
      "claude_local",
      "codex_local",
      "opencode_local",
      "pi_local",
      "gemini_local",
      "grok_local",
      "copilot_runtime",
      "antigravity_runtime",
      "hermes_local",
      "kimi_local",
    ]) {
      expect(adapterUsesManagedAiConnection(adapter), adapter).toBe(true);
    }
  });

  it("treats CLI sign-in harnesses as unmanaged", () => {
    for (const adapter of ["cursor_local", "unsupported"]) {
      expect(adapterUsesManagedAiConnection(adapter), adapter).toBe(false);
    }
  });
});

describe("Kimi connections", () => {
  it("accepts a fixed Kimi API-key binding on the Kimi harness only", () => {
    const binding = {
      provider: "kimi",
      method: "api_key",
      mode: "delegated",
      connectionId: "00000000-0000-4000-8000-000000000000",
      grantId: "00000000-0000-4000-8000-000000000001",
    } as const;
    expect(isAiConnectionCompatible(binding, "kimi_local", "kimi-code/k3")).toBe(true);
    expect(isAiConnectionCompatible(binding, "pi_local", "kimi-code/k3")).toBe(false);
    expect(isAiConnectionCompatible({ provider: "kimi", method: "api_key", mode: "responsible_user" }, "kimi_local", "kimi-code/k3")).toBe(true);
    expect(isAiConnectionCompatible({ provider: "anthropic", method: "api_key", mode: "responsible_user" }, "kimi_local", "kimi-code/k3")).toBe(false);
    expect(isAiConnectionCompatible({ ...binding, method: "subscription" }, "kimi_local", "kimi-code/k3")).toBe(false);
  });
});

describe("DeepSeek connections", () => {
  it("binds a DeepSeek API key to OpenCode running a deepseek model", () => {
    const binding = {
      provider: "deepseek",
      method: "api_key",
      mode: "delegated",
      connectionId: "00000000-0000-4000-8000-000000000000",
      grantId: "00000000-0000-4000-8000-000000000002",
    } as const;
    expect(isAiConnectionCompatible(binding, "opencode_local", "deepseek/deepseek-chat")).toBe(true);
    // Connection metadata (no explicit binding) still requires the model prefix,
    // mirroring the OpenRouter rule for OpenCode.
    expect(isAiConnectionCompatible({ provider: "deepseek", method: "api_key" }, "opencode_local", "openai/gpt-5.1")).toBe(false);
    expect(isAiConnectionCompatible({ provider: "deepseek", method: "api_key" }, "opencode_local", "deepseek/deepseek-chat")).toBe(true);
    expect(isAiConnectionCompatible({ provider: "deepseek", method: "api_key" }, "codex_local", "deepseek/deepseek-chat")).toBe(false);
    expect(isAiConnectionCompatible({ ...binding, method: "subscription" }, "opencode_local", "deepseek/deepseek-chat")).toBe(false);
  });
});
