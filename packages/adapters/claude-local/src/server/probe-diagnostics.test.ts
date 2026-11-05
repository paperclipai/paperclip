import { describe, expect, it, vi } from "vitest";
import {
  buildClaudeLoginRequiredHint,
  classifyThrownErrorClass,
  logSandboxProbeDiagnostic,
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

describe("classifyThrownErrorClass", () => {
  it("returns the constructor name for an Error", () => {
    expect(classifyThrownErrorClass(new TypeError("boom"))).toBe("TypeError");
    expect(classifyThrownErrorClass(new Error("boom"))).toBe("Error");
  });

  it("returns null for a non-Error value", () => {
    expect(classifyThrownErrorClass("a raw secret string")).toBeNull();
    expect(classifyThrownErrorClass(null)).toBeNull();
    expect(classifyThrownErrorClass({ message: "opaque" })).toBeNull();
  });
});

describe("logSandboxProbeDiagnostic", () => {
  it("logs only the fixed context and the allowlisted classification", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSandboxProbeDiagnostic("probe failed", "auth_required");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith("[paperclip] probe failed", {
      classification: "auth_required",
    });
    warnSpy.mockRestore();
  });

  it("adds a finite exit code as a structured field", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSandboxProbeDiagnostic("probe failed", "nonzero_exit", { exitCode: 3 });
    expect(warnSpy).toHaveBeenCalledWith("[paperclip] probe failed", {
      classification: "nonzero_exit",
      exitCode: 3,
    });
    warnSpy.mockRestore();
  });

  it("drops a null or non-finite exit code", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSandboxProbeDiagnostic("probe failed", "nonzero_exit", { exitCode: null });
    logSandboxProbeDiagnostic("probe failed", "nonzero_exit", { exitCode: Number.NaN });
    for (const call of warnSpy.mock.calls) {
      expect(call[1]).toEqual({ classification: "nonzero_exit" });
    }
    warnSpy.mockRestore();
  });

  it("sanitizes the error class to an identifier and bounds its length", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A crafted error class name that carries an opaque marker and a proxy URL.
    // The sanitizer must strip every non-identifier character and bound the
    // length, so no structured secret shape reaches the log.
    logSandboxProbeDiagnostic("probe failed", "spawn_error", {
      errorClass: `MARKER-LEAK http://user:pass@proxy.internal:8080/path?t=${"x".repeat(200)}`,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const detail = warnSpy.mock.calls[0]![1] as { errorClass?: string };
    expect(detail.errorClass).toMatch(/^[A-Za-z0-9_$]+$/);
    expect(detail.errorClass!.length).toBeLessThanOrEqual(64);
    // The separators and the proxy structure do not survive.
    expect(detail.errorClass).not.toContain("-");
    expect(detail.errorClass).not.toContain(":");
    expect(detail.errorClass).not.toContain("/");
    warnSpy.mockRestore();
  });

  it("drops an empty or non-string error class", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSandboxProbeDiagnostic("probe failed", "spawn_error", { errorClass: null });
    logSandboxProbeDiagnostic("probe failed", "spawn_error", { errorClass: "***" });
    for (const call of warnSpy.mock.calls) {
      expect(call[1]).toEqual({ classification: "spawn_error" });
    }
    warnSpy.mockRestore();
  });
});
