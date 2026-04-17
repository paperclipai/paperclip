import { describe, it, expect } from "vitest";
import { categorizeAdapterError } from "./adapter-failure-taxonomy.js";

describe("categorizeAdapterError", () => {
  it("returns 'unknown' for null errorCode", () => {
    expect(categorizeAdapterError(null)).toBe("unknown");
  });

  it("returns 'unknown' for undefined errorCode", () => {
    expect(categorizeAdapterError(undefined)).toBe("unknown");
  });

  it("returns 'unknown' for empty string errorCode", () => {
    expect(categorizeAdapterError("")).toBe("unknown");
  });

  it("returns 'auth_required' for canonical auth_required code", () => {
    expect(categorizeAdapterError("auth_required")).toBe("auth_required");
  });

  it("returns 'auth_required' for legacy claude_auth_required code", () => {
    expect(categorizeAdapterError("claude_auth_required")).toBe("auth_required");
  });

  it("returns 'rate_limited' for canonical rate_limited code", () => {
    expect(categorizeAdapterError("rate_limited")).toBe("rate_limited");
  });

  it("returns 'rate_limited' for legacy claude_rate_limited code", () => {
    expect(categorizeAdapterError("claude_rate_limited")).toBe("rate_limited");
  });

  it("returns 'session_invalid' for canonical session_invalid code", () => {
    expect(categorizeAdapterError("session_invalid")).toBe("session_invalid");
  });

  it("returns 'session_invalid' for legacy claude_session_invalid code", () => {
    expect(categorizeAdapterError("claude_session_invalid")).toBe("session_invalid");
  });

  it("returns 'startup_failed' for canonical startup_failed code", () => {
    expect(categorizeAdapterError("startup_failed")).toBe("startup_failed");
  });

  it("returns 'startup_failed' for legacy startup_failure code", () => {
    expect(categorizeAdapterError("startup_failure")).toBe("startup_failed");
  });

  it("returns 'timeout' for timeout code", () => {
    expect(categorizeAdapterError("timeout")).toBe("timeout");
  });

  it("returns 'provider_unavailable' for provider_unavailable code", () => {
    expect(categorizeAdapterError("provider_unavailable")).toBe("provider_unavailable");
  });

  it("returns 'process_lost' for canonical process_lost code", () => {
    expect(categorizeAdapterError("process_lost")).toBe("process_lost");
  });

  it("returns 'process_lost' for legacy process_detached code", () => {
    expect(categorizeAdapterError("process_detached")).toBe("process_lost");
  });

  it("returns 'crash_no_output' for canonical crash_no_output code", () => {
    expect(categorizeAdapterError("crash_no_output")).toBe("crash_no_output");
  });

  it("returns 'crash_no_output' for legacy claude_crash_no_output code", () => {
    expect(categorizeAdapterError("claude_crash_no_output")).toBe("crash_no_output");
  });

  it("returns 'parse_error' for canonical parse_error code", () => {
    expect(categorizeAdapterError("parse_error")).toBe("parse_error");
  });

  it("returns 'parse_error' for legacy claude_json_parse_failed code", () => {
    expect(categorizeAdapterError("claude_json_parse_failed")).toBe("parse_error");
  });

  it("returns 'cancelled' for cancelled code", () => {
    expect(categorizeAdapterError("cancelled")).toBe("cancelled");
  });

  it("returns 'nonzero_exit' for nonzero_exit code", () => {
    expect(categorizeAdapterError("nonzero_exit")).toBe("nonzero_exit");
  });

  it("returns 'unknown' for all_adapters_exhausted code", () => {
    expect(categorizeAdapterError("all_adapters_exhausted")).toBe("unknown");
  });

  it("returns 'unknown' for an unrecognized error code", () => {
    expect(categorizeAdapterError("some_random_error")).toBe("unknown");
  });

  it("returns 'unknown' for a partially matching code that is not in the switch", () => {
    expect(categorizeAdapterError("auth_require")).toBe("unknown");
  });
});
