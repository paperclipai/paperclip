import { describe, expect, it } from "vitest";
import { supportsManagedNativeWarmSession, supportsNativeWarmFiles } from "./native-warm-capability.js";
import type { PaperclipRunnerProviderProfile } from "./provider-profile.js";

describe("native warm credential and file admission", () => {
  const copilot: PaperclipRunnerProviderProfile = {
    provider: "acpx", backend: "acpx_runtime", acpxAgent: "copilot", model: "gpt-5.6-luna",
  };
  it("admits the saved Copilot token with its session-owned home and file handoff", () => {
    expect(supportsNativeWarmFiles(copilot)).toBe(true);
    expect(supportsManagedNativeWarmSession(copilot, { provider: "github", method: "api_key" })).toBe(true);
  });
  it.each([undefined, { provider: "github", method: "subscription" }, { provider: "openai", method: "api_key" }])(
    "refuses a missing or mismatched Copilot credential: %j", (attribution) => {
      expect(supportsManagedNativeWarmSession(copilot, attribution)).toBe(false);
    },
  );
  it.each(["cursor", "pi", "claude", "grok"] as const)("preserves %s managed per-turn admission", (acpxAgent) => {
    const profile = { ...copilot, acpxAgent };
    expect(supportsNativeWarmFiles(profile)).toBe(false);
    expect(supportsManagedNativeWarmSession(profile, { provider: "github", method: "api_key" })).toBe(false);
  });
  it("preserves Codex warm support", () => {
    const profile: PaperclipRunnerProviderProfile = { provider: "codex", backend: "codex_app_server", model: "gpt-5.6-sol" };
    expect(supportsNativeWarmFiles(profile)).toBe(true);
    expect(supportsManagedNativeWarmSession(profile, undefined)).toBe(true);
  });
});
