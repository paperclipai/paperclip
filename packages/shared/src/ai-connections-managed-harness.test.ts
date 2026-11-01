import { describe, expect, it } from "vitest";
import { isAiConnectionCompatible, isAiConnectionManagedAdapter, isAiConnectionSelfAuthenticatedAdapter } from "./ai-connections.js";

const shared = { mode: "shared", connectionId: "11111111-1111-4111-8111-111111111111", grantId: "22222222-2222-4222-8222-222222222222" } as const;

describe("managed AI connection harnesses", () => {
  it("keeps saved Copilot accounts compatible with the Copilot runtime harness", () => {
    // Onboarding and the account picker pass the runner harness itself.
    expect(isAiConnectionCompatible({ provider: "github", method: "api_key" }, "copilot_runtime")).toBe(true);
    expect(isAiConnectionCompatible({ provider: "github", method: "api_key", mode: "responsible_user" }, "copilot_runtime")).toBe(true);
    expect(isAiConnectionCompatible({ provider: "github", method: "api_key", ...shared }, "copilot_runtime")).toBe(true);
    // The stored agent shape resolves to the same harness.
    expect(isAiConnectionCompatible({ provider: "github", method: "api_key" }, "paperclip_runner", "gpt-5", "acpx", "copilot")).toBe(true);
    expect(isAiConnectionCompatible({ provider: "anthropic", method: "api_key" }, "copilot_runtime")).toBe(false);
  });

  it("classifies every capability harness as managed and keeps self-authenticated adapters out", () => {
    for (const harness of ["paperclip_runner", "claude_local", "codex_local", "opencode_local", "grok_local", "gemini_local", "hermes_local", "pi_local", "copilot_runtime", "antigravity_runtime"]) {
      expect(isAiConnectionManagedAdapter(harness)).toBe(true);
      expect(isAiConnectionSelfAuthenticatedAdapter(harness)).toBe(false);
    }
    for (const adapter of ["hermes_gateway", "openclaw_gateway", "cursor_cloud", "cursor", "kimi_local"]) {
      expect(isAiConnectionSelfAuthenticatedAdapter(adapter)).toBe(true);
      expect(isAiConnectionManagedAdapter(adapter)).toBe(false);
      expect(isAiConnectionCompatible({ provider: "anthropic", method: "api_key", mode: "responsible_user" }, adapter)).toBe(false);
    }
    for (const adapter of ["process", "http", "external", "unknown_adapter"]) {
      expect(isAiConnectionManagedAdapter(adapter)).toBe(false);
      expect(isAiConnectionCompatible({ provider: "anthropic", method: "api_key" }, adapter)).toBe(false);
    }
    // A runner provider without a managed harness stays incompatible.
    expect(isAiConnectionCompatible({ provider: "anthropic", method: "api_key" }, "paperclip_runner", "m", "acpx", "custom")).toBe(false);
  });
});
