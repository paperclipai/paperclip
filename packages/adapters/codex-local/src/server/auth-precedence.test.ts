import { describe, expect, it } from "vitest";
import {
  CODEX_SANDBOX_AUTH_EXISTS_COMMAND,
  CODEX_SANDBOX_AUTH_PRECEDENCE_WARNING,
  CODEX_SANDBOX_AUTH_PRECEDENCE_WARNING_LOG_LINE,
  resolveCodexAuthPrecedence,
} from "./auth-precedence.js";

describe("resolveCodexAuthPrecedence", () => {
  describe("precedence order", () => {
    it("configured_api_key wins over all other sources", () => {
      const result = resolveCodexAuthPrecedence({
        configuredApiKey: true,
        hostAuthJson: true,
        sandboxAuthJson: true,
      });
      expect(result.winner).toBe("configured_api_key");
    });

    it("host_auth_json wins when no configured api key", () => {
      const result = resolveCodexAuthPrecedence({
        configuredApiKey: false,
        hostAuthJson: true,
        sandboxAuthJson: true,
      });
      expect(result.winner).toBe("host_auth_json");
    });

    it("sandbox_auth_json wins when no host credentials", () => {
      const result = resolveCodexAuthPrecedence({
        configuredApiKey: false,
        hostAuthJson: false,
        sandboxAuthJson: true,
      });
      expect(result.winner).toBe("sandbox_auth_json");
    });

    it("none when no credentials present", () => {
      const result = resolveCodexAuthPrecedence({
        configuredApiKey: false,
        hostAuthJson: false,
        sandboxAuthJson: false,
      });
      expect(result.winner).toBe("none");
    });
  });

  describe("sandbox login shadowing and warning", () => {
    it("warns when configured_api_key shadows sandbox login", () => {
      const result = resolveCodexAuthPrecedence({
        configuredApiKey: true,
        hostAuthJson: false,
        sandboxAuthJson: true,
      });
      expect(result.sandboxLoginShadowed).toBe(true);
      expect(result.shouldWarn).toBe(true);
    });

    it("warns when host_auth_json shadows sandbox login", () => {
      const result = resolveCodexAuthPrecedence({
        configuredApiKey: false,
        hostAuthJson: true,
        sandboxAuthJson: true,
      });
      expect(result.sandboxLoginShadowed).toBe(true);
      expect(result.shouldWarn).toBe(true);
    });

    it("does not warn when sandbox login wins (no host credentials)", () => {
      const result = resolveCodexAuthPrecedence({
        configuredApiKey: false,
        hostAuthJson: false,
        sandboxAuthJson: true,
      });
      expect(result.sandboxLoginShadowed).toBe(false);
      expect(result.shouldWarn).toBe(false);
    });

    it("does not warn when no sandbox login exists (sandbox-only gate)", () => {
      const result = resolveCodexAuthPrecedence({
        configuredApiKey: true,
        hostAuthJson: true,
        sandboxAuthJson: false,
      });
      expect(result.sandboxLoginShadowed).toBe(false);
      expect(result.shouldWarn).toBe(false);
    });

    it("does not warn when no credentials exist at all (fail-open)", () => {
      const result = resolveCodexAuthPrecedence({
        configuredApiKey: false,
        hostAuthJson: false,
        sandboxAuthJson: false,
      });
      expect(result.sandboxLoginShadowed).toBe(false);
      expect(result.shouldWarn).toBe(false);
    });
  });

  describe("constants", () => {
    it("warning message is stable and human-readable", () => {
      expect(CODEX_SANDBOX_AUTH_PRECEDENCE_WARNING).toBe(
        "snapshot login present but configured or host credentials take precedence",
      );
    });

    it("log line wraps the warning message", () => {
      expect(CODEX_SANDBOX_AUTH_PRECEDENCE_WARNING_LOG_LINE).toContain(
        CODEX_SANDBOX_AUTH_PRECEDENCE_WARNING,
      );
      expect(CODEX_SANDBOX_AUTH_PRECEDENCE_WARNING_LOG_LINE).toMatch(
        /^\[paperclip\] Warning:/,
      );
    });

    it("sandbox auth exists command is a static shell test", () => {
      expect(CODEX_SANDBOX_AUTH_EXISTS_COMMAND).toBe(
        'test -f "$HOME/.codex/auth.json"',
      );
      expect(CODEX_SANDBOX_AUTH_EXISTS_COMMAND).not.toContain("cat");
      expect(CODEX_SANDBOX_AUTH_EXISTS_COMMAND).not.toContain("readFile");
    });
  });
});
