import { describe, expect, it } from "vitest";
import {
  defaultCreateValues,
  adapterConfigDefaults,
  getCreateValuesForAdapterType,
} from "./agent-config-defaults";

describe("agent-config-defaults", () => {
  describe("defaultCreateValues", () => {
    it("has claude_local as the default adapter type", () => {
      expect(defaultCreateValues.adapterType).toBe("claude_local");
    });

    it("sets dangerouslySkipPermissions=true by default", () => {
      expect(defaultCreateValues.dangerouslySkipPermissions).toBe(true);
    });

    it("sets dangerouslyBypassSandbox=false by default", () => {
      expect(defaultCreateValues.dangerouslyBypassSandbox).toBe(false);
    });
  });

  describe("adapterConfigDefaults dictionary", () => {
    it("has an entry for claude_local with dangerouslySkipPermissions=true", () => {
      expect(adapterConfigDefaults.claude_local).toBeDefined();
      expect(adapterConfigDefaults.claude_local.dangerouslySkipPermissions).toBe(true);
    });

    it("has an entry for opencode_local with dangerouslySkipPermissions=true", () => {
      expect(adapterConfigDefaults.opencode_local).toBeDefined();
      expect(adapterConfigDefaults.opencode_local.dangerouslySkipPermissions).toBe(true);
    });

    it("has an entry for codex_local with model and bypass defaults", () => {
      expect(adapterConfigDefaults.codex_local).toBeDefined();
      expect(adapterConfigDefaults.codex_local.model).toBeTruthy();
      expect(adapterConfigDefaults.codex_local.dangerouslyBypassSandbox).toBe(true);
    });

    it("has an entry for gemini_local with a model default", () => {
      expect(adapterConfigDefaults.gemini_local).toBeDefined();
      expect(adapterConfigDefaults.gemini_local.model).toBeTruthy();
    });

    it("has an entry for cursor with a model default", () => {
      expect(adapterConfigDefaults.cursor).toBeDefined();
      expect(adapterConfigDefaults.cursor.model).toBeTruthy();
    });
  });

  describe("getCreateValuesForAdapterType()", () => {
    it("returns claude_local defaults with dangerouslySkipPermissions=true", () => {
      const values = getCreateValuesForAdapterType("claude_local");
      expect(values.adapterType).toBe("claude_local");
      expect(values.dangerouslySkipPermissions).toBe(true);
      expect(values.maxTurnsPerRun).toBe(1000);
    });

    it("returns codex_local defaults with model and bypass overrides", () => {
      const values = getCreateValuesForAdapterType("codex_local");
      expect(values.adapterType).toBe("codex_local");
      expect(values.model).toBeTruthy();
      expect(values.dangerouslyBypassSandbox).toBe(true);
      // codex_local has no dangerouslySkipPermissions override, so it inherits the base default (true)
      expect(values.dangerouslySkipPermissions).toBe(true);
    });

    it("returns opencode_local defaults with skip permissions and empty model", () => {
      const values = getCreateValuesForAdapterType("opencode_local");
      expect(values.adapterType).toBe("opencode_local");
      expect(values.dangerouslySkipPermissions).toBe(true);
      expect(values.model).toBe("");
    });

    it("returns gemini_local defaults with model", () => {
      const values = getCreateValuesForAdapterType("gemini_local");
      expect(values.adapterType).toBe("gemini_local");
      expect(values.model).toBeTruthy();
    });

    it("returns cursor defaults with model", () => {
      const values = getCreateValuesForAdapterType("cursor");
      expect(values.adapterType).toBe("cursor");
      expect(values.model).toBeTruthy();
    });

    it("returns base defaults for unknown adapter type", () => {
      const values = getCreateValuesForAdapterType("some_unknown_adapter");
      expect(values.adapterType).toBe("some_unknown_adapter");
      // Falls back to base defaults
      expect(values.dangerouslySkipPermissions).toBe(true);
      expect(values.model).toBe("");
    });

    it("adapter type switching resets all fields to fresh defaults", () => {
      // Simulate: user picks claude_local, then switches to codex_local
      const claude = getCreateValuesForAdapterType("claude_local");
      expect(claude.dangerouslyBypassSandbox).toBe(false); // claude has no bypass override

      const codex = getCreateValuesForAdapterType("codex_local");
      expect(codex.dangerouslyBypassSandbox).toBe(true); // codex has bypass=true

      // Switch back to claude — bypass should reset to false
      const claudeAgain = getCreateValuesForAdapterType("claude_local");
      expect(claudeAgain.dangerouslyBypassSandbox).toBe(false);
    });

    it("preserves all required CreateConfigValues fields", () => {
      const values = getCreateValuesForAdapterType("claude_local");
      // Verify a sampling of fields that must always be present
      expect(values).toHaveProperty("adapterType");
      expect(values).toHaveProperty("cwd");
      expect(values).toHaveProperty("dangerouslySkipPermissions");
      expect(values).toHaveProperty("dangerouslyBypassSandbox");
      expect(values).toHaveProperty("maxTurnsPerRun");
      expect(values).toHaveProperty("heartbeatEnabled");
      expect(values).toHaveProperty("intervalSec");
    });
  });
});
