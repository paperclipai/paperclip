import { describe, it, expect } from "vitest";

// Test the transient error detection patterns directly
// These patterns are defined in heartbeat.ts but we test the matching logic here

const TRANSIENT_ERROR_PATTERNS = [
  "overloaded_error",
  "overloaded",
  '"type":"api_error"',
  "Internal server error",
  "API Error: 500",
  "API Error: 529",
  "API Error: 503",
  "Service Unavailable",
];

function isTransientApiError(errorMessage: string | null | undefined): boolean {
  if (!errorMessage) return false;
  return TRANSIENT_ERROR_PATTERNS.some((pattern) => errorMessage.includes(pattern));
}

describe("isTransientApiError", () => {
  it("detects 500 API errors", () => {
    expect(isTransientApiError('API Error: 500 {"type":"api_error","message":"Internal server error"}')).toBe(true);
  });

  it("detects 529 overloaded errors", () => {
    expect(isTransientApiError('API Error: 529 {"type":"overloaded_error","message":"Overloaded"}')).toBe(true);
  });

  it("detects 503 service unavailable", () => {
    expect(isTransientApiError("API Error: 503 Service Unavailable")).toBe(true);
  });

  it("detects overloaded_error in JSON", () => {
    expect(isTransientApiError('{"type":"overloaded_error"}')).toBe(true);
  });

  it("does not match normal adapter failures", () => {
    expect(isTransientApiError("Process exited with code 1")).toBe(false);
  });

  it("does not match authentication errors", () => {
    expect(isTransientApiError("401 Unauthorized")).toBe(false);
  });

  it("does not match rate limit errors (should wait, not retry)", () => {
    expect(isTransientApiError("429 Too Many Requests")).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isTransientApiError(null)).toBe(false);
    expect(isTransientApiError(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isTransientApiError("")).toBe(false);
  });
});
