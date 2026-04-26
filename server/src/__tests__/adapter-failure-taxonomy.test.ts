import { describe, expect, it } from "vitest";
import { categorizeAdapterError } from "../services/adapter-failure-taxonomy.js";
import type { AdapterFailureCategory, AdapterFallbackEntry } from "@paperclipai/adapter-utils";

describe("categorizeAdapterError", () => {
  it("returns unknown for null/undefined", () => {
    expect(categorizeAdapterError(null)).toBe("unknown");
    expect(categorizeAdapterError(undefined)).toBe("unknown");
    expect(categorizeAdapterError("")).toBe("unknown");
  });

  it("maps canonical codes directly", () => {
    const cases: Array<[string, AdapterFailureCategory]> = [
      ["auth_required", "auth_required"],
      ["rate_limited", "rate_limited"],
      ["session_invalid", "session_invalid"],
      ["startup_failed", "startup_failed"],
      ["timeout", "timeout"],
      ["provider_unavailable", "provider_unavailable"],
      ["process_lost", "process_lost"],
      ["crash_no_output", "crash_no_output"],
      ["parse_error", "parse_error"],
      ["cancelled", "cancelled"],
      ["nonzero_exit", "nonzero_exit"],
    ];
    for (const [code, expected] of cases) {
      expect(categorizeAdapterError(code)).toBe(expected);
    }
  });

  it("maps legacy claude-prefixed codes to canonical categories", () => {
    expect(categorizeAdapterError("claude_auth_required")).toBe("auth_required");
    expect(categorizeAdapterError("claude_rate_limited")).toBe("rate_limited");
    expect(categorizeAdapterError("claude_session_invalid")).toBe("session_invalid");
    expect(categorizeAdapterError("claude_crash_no_output")).toBe("crash_no_output");
    expect(categorizeAdapterError("claude_json_parse_failed")).toBe("parse_error");
  });

  it("maps process_detached (DETACHED_PROCESS_ERROR_CODE) to process_lost", () => {
    expect(categorizeAdapterError("process_detached")).toBe("process_lost");
  });

  it("maps startup_failure variant to startup_failed", () => {
    expect(categorizeAdapterError("startup_failure")).toBe("startup_failed");
  });

  it("returns unknown for unrecognized codes", () => {
    expect(categorizeAdapterError("adapter_failed")).toBe("unknown");
    expect(categorizeAdapterError("some_random_error")).toBe("unknown");
  });
});

describe("AdapterFallbackEntry triggerOn filtering (non-Claude fallback scenario)", () => {
  it("correctly identifies when a fallback should trigger for rate_limited", () => {
    // Simulates: codex_local is rate_limited → should fall back to claude_local
    const fallbackEntry: AdapterFallbackEntry = {
      adapterType: "claude_local",
      adapterConfig: { model: "claude-sonnet-4-5" },
      triggerOn: ["rate_limited", "provider_unavailable"],
    };

    const primaryErrorCode = "rate_limited";
    const failureCategory = categorizeAdapterError(primaryErrorCode);

    const shouldTrigger =
      !fallbackEntry.triggerOn || fallbackEntry.triggerOn.includes(failureCategory);

    expect(shouldTrigger).toBe(true);
  });

  it("does not trigger fallback when failure category is not in triggerOn", () => {
    const fallbackEntry: AdapterFallbackEntry = {
      adapterType: "claude_local",
      triggerOn: ["rate_limited"],
    };

    const failureCategory = categorizeAdapterError("auth_required");
    const shouldTrigger =
      !fallbackEntry.triggerOn || fallbackEntry.triggerOn.includes(failureCategory);

    expect(shouldTrigger).toBe(false);
  });

  it("triggers fallback for any failure when triggerOn is omitted", () => {
    const fallbackEntry: AdapterFallbackEntry = {
      adapterType: "claude_local",
    };

    for (const code of ["auth_required", "rate_limited", "crash_no_output", "unknown"]) {
      const failureCategory = categorizeAdapterError(code);
      const shouldTrigger =
        !fallbackEntry.triggerOn || fallbackEntry.triggerOn.includes(failureCategory);
      expect(shouldTrigger).toBe(true);
    }
  });
});
