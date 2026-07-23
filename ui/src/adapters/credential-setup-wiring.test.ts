import { describe, expect, it } from "vitest";
import { getUIAdapter } from "./registry";

describe("adapter credential-setup wiring", () => {
  it("exposes the claude_local credential-setup descriptor on the registry", () => {
    const setup = getUIAdapter("claude_local")?.credentialSetup;
    expect(setup).toBeDefined();
    expect(setup?.options[0].envKey).toBe("ANTHROPIC_API_KEY");
  });

  it("exposes descriptors for the other built-in adapters that have one", () => {
    for (const type of ["codex_local", "gemini_local", "opencode_local", "pi_local", "cursor"]) {
      const setup = getUIAdapter(type)?.credentialSetup;
      expect(setup, `expected credentialSetup for ${type}`).toBeDefined();
      expect(setup?.options.length).toBeGreaterThan(0);
    }
  });

  it("resolves undefined for a registered adapter without a descriptor", () => {
    expect(getUIAdapter("http")?.credentialSetup).toBeUndefined();
  });
});
