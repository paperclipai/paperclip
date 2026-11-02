import { describe, expect, it } from "vitest";
import { agentHarnessType, agentRuntimeSettingsHarness, paperclipRunnerProfileForHarness } from "./agent-runner.js";
import { aiConnectionMetadataSchema, isAiConnectionCompatible } from "./ai-connections.js";
import { aiRoutingHarness } from "./ai-provider-routing.js";

describe("Antigravity native runtime identity and credentials", () => {
  const config = { provider: "acpx", acpxAgent: "antigravity" };
  const compatible = (connection: Parameters<typeof isAiConnectionCompatible>[0]) =>
    isAiConnectionCompatible(connection, "paperclip_runner", "exact-model", "acpx", "antigravity");

  it("uses a native harness identity without a legacy adapter transition", () => {
    expect(agentHarnessType("paperclip_runner", config)).toBe("antigravity_runtime");
    expect(agentRuntimeSettingsHarness("paperclip_runner", config)).toBe("antigravity_runtime");
    expect(aiRoutingHarness("paperclip_runner", "acpx", "antigravity")).toBe("antigravity_runtime");
    expect(paperclipRunnerProfileForHarness("antigravity_runtime")).toBeUndefined();
  });

  it("accepts Google runtime sign-in and API keys without tool OAuth or custom endpoints", () => {
    expect(compatible({ provider: "google", method: "api_key" })).toBe(true);
    expect(compatible({ provider: "google", method: "api_key", mode: "responsible_user" })).toBe(true);
    expect(compatible({ provider: "google", method: "api_key", mode: "delegated",
      connectionId: "11111111-1111-4111-8111-111111111111", grantId: "22222222-2222-4222-8222-222222222222" })).toBe(true);
    expect(compatible({ provider: "google", method: "subscription" })).toBe(true);
    expect(isAiConnectionCompatible({ provider: "google", method: "subscription" }, "gemini_local")).toBe(false);
    expect(aiConnectionMetadataSchema.safeParse({ provider: "google", method: "oauth" }).success).toBe(false);
    for (const provider of ["openai", "anthropic", "openrouter", "github", "xai"] as const) {
      expect(compatible({ provider, method: "api_key" })).toBe(false);
      expect(compatible({ provider, method: "api_key", mode: "shared",
        connectionId: "11111111-1111-4111-8111-111111111111", grantId: "22222222-2222-4222-8222-222222222222" })).toBe(false);
    }
    expect(compatible({ provider: "google", method: "api_key", routing: {
      kind: "openrouter", protocol: "chat", auth: "bearer", models: [],
    } })).toBe(false);
  });
});
