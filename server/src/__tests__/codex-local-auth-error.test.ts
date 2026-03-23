import { describe, expect, it } from "vitest";
import { isCodexAuthError } from "@paperclipai/adapter-codex-local/server";

describe("codex_local auth error detection (GH #1511)", () => {
  it("detects 401 status code in stderr", () => {
    expect(isCodexAuthError("", '{"error":"Agent authentication required"} 401')).toBe(true);
  });

  it("detects 'unauthorized' keyword", () => {
    expect(isCodexAuthError("", "Error: Unauthorized access")).toBe(true);
  });

  it("detects 'authentication required'", () => {
    expect(isCodexAuthError("", 'HTTP 401 {"error":"Agent authentication required"}')).toBe(true);
  });

  it("detects 'expired token'", () => {
    expect(isCodexAuthError("expired token error", "")).toBe(true);
  });

  it("detects 'invalid token'", () => {
    expect(isCodexAuthError("invalid token provided", "")).toBe(true);
  });

  it("returns false for normal errors", () => {
    expect(isCodexAuthError("", "Error: file not found")).toBe(false);
  });

  it("returns false for empty output", () => {
    expect(isCodexAuthError("", "")).toBe(false);
  });

  it("returns false for unknown session error (different from auth)", () => {
    expect(isCodexAuthError("", "unknown session abc123")).toBe(false);
  });
});
