import { describe, expect, it, vi } from "vitest";
import {
  buildClaudeLoginRequiredHint,
  logRedactedSandboxProbeDiagnostic,
  normalizeClaudeLoginUrl,
} from "./probe-diagnostics.js";

describe("normalizeClaudeLoginUrl", () => {
  it("accepts an allowlisted https Claude host with no query or fragment", () => {
    expect(normalizeClaudeLoginUrl("https://claude.ai/login")).toBe("https://claude.ai/login");
  });

  it("accepts an allowlisted Anthropic subdomain", () => {
    expect(normalizeClaudeLoginUrl("https://console.anthropic.com/login")).toBe(
      "https://console.anthropic.com/login",
    );
  });

  it("rejects a URL with a query", () => {
    expect(normalizeClaudeLoginUrl("https://claude.ai/login?token=secret")).toBeNull();
  });

  it("rejects a URL with a fragment", () => {
    expect(normalizeClaudeLoginUrl("https://claude.ai/login#access_token=secret")).toBeNull();
  });

  it("rejects a non-https URL", () => {
    expect(normalizeClaudeLoginUrl("http://claude.ai/login")).toBeNull();
  });

  it("rejects a non-allowlisted host", () => {
    expect(normalizeClaudeLoginUrl("https://evil.example.com/claude-login")).toBeNull();
  });

  it("rejects a look-alike host that only ends with the brand word", () => {
    expect(normalizeClaudeLoginUrl("https://claude.ai.evil.com/login")).toBeNull();
    expect(normalizeClaudeLoginUrl("https://notclaude.ai/login")).toBeNull();
  });

  it("rejects a URL that embeds credentials or a port", () => {
    expect(normalizeClaudeLoginUrl("https://user:pass@claude.ai/login")).toBeNull();
    expect(normalizeClaudeLoginUrl("https://claude.ai:8443/login")).toBeNull();
  });

  it("returns null for empty or malformed input", () => {
    expect(normalizeClaudeLoginUrl(null)).toBeNull();
    expect(normalizeClaudeLoginUrl(undefined)).toBeNull();
    expect(normalizeClaudeLoginUrl("not a url")).toBeNull();
  });
});

describe("buildClaudeLoginRequiredHint", () => {
  it("names a safe login URL in the hint", () => {
    expect(buildClaudeLoginRequiredHint("https://claude.ai/login")).toBe(
      "Run `claude login` and complete sign-in at https://claude.ai/login, then retry.",
    );
  });

  it("falls back to the fixed hint for an unsafe URL", () => {
    expect(buildClaudeLoginRequiredHint("https://evil.example.com/claude-login?leak=secret")).toBe(
      "Run `claude login` in this environment, then retry the probe.",
    );
  });

  it("falls back to the fixed hint for a null URL", () => {
    expect(buildClaudeLoginRequiredHint(null)).toBe(
      "Run `claude login` in this environment, then retry the probe.",
    );
  });
});

describe("logRedactedSandboxProbeDiagnostic", () => {
  it("redacts a JSON secret field before it reaches the log", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logRedactedSandboxProbeDiagnostic("probe failed", '{"token":"opaque-secret-value"}');
    const loggedText = JSON.stringify(warnSpy.mock.calls);
    expect(loggedText).not.toContain("opaque-secret-value");
    expect(loggedText).toContain("***REDACTED***");
    warnSpy.mockRestore();
  });

  it("does not log when the diagnostic is empty", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logRedactedSandboxProbeDiagnostic("probe failed", "");
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("redacts a JSON secret value with an escaped quote before it reaches the log", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // The value holds an escaped quote, then the rest of the credential. A naive
    // matcher stops at the escaped quote and leaks the marker to the log.
    logRedactedSandboxProbeDiagnostic("probe failed", '{"token":"pre\\"MARKERLOGQUOTE"}');
    const loggedText = JSON.stringify(warnSpy.mock.calls);
    expect(loggedText).not.toContain("MARKERLOGQUOTE");
    expect(loggedText).toContain("***REDACTED***");
    warnSpy.mockRestore();
  });

  it("redacts an escaped-JSON secret value before it reaches the log", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const innerJson = '{"password":"pre\\\\MARKERLOGBACKSLASH"}';
    logRedactedSandboxProbeDiagnostic("probe failed", JSON.stringify(innerJson));
    const loggedText = JSON.stringify(warnSpy.mock.calls);
    expect(loggedText).not.toContain("MARKERLOGBACKSLASH");
    expect(loggedText).toContain("***REDACTED***");
    warnSpy.mockRestore();
  });
});
