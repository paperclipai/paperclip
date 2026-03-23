import { describe, expect, it } from "vitest";
import { isTransientApiError } from "../services/transient-error-detection.ts";

describe("isTransientApiError", () => {
  describe("detects transient errors", () => {
    it("detects HTTP 500 with api_error type", () => {
      expect(
        isTransientApiError(
          'API Error: 500 {"type":"api_error","message":"Internal server error"}',
          null,
        ),
      ).toBe(true);
    });

    it("detects HTTP 529 overloaded error", () => {
      expect(
        isTransientApiError(
          'API Error: 529 {"type":"overloaded_error","message":"Overloaded"}',
          null,
        ),
      ).toBe(true);
    });

    it("detects HTTP 503 service unavailable", () => {
      expect(
        isTransientApiError(
          "API Error: 503 Service Unavailable",
          null,
        ),
      ).toBe(true);
    });

    it("detects overloaded_error in error message", () => {
      expect(
        isTransientApiError("overloaded_error", null),
      ).toBe(true);
    });

    it("detects structured overloaded_error JSON", () => {
      expect(
        isTransientApiError(
          null,
          '{"type": "overloaded_error", "message": "Overloaded"}',
        ),
      ).toBe(true);
    });

    it("detects transient error from stderr excerpt", () => {
      expect(
        isTransientApiError(
          null,
          'Error: API Error: 529 {"type":"overloaded_error","message":"Overloaded"}',
        ),
      ).toBe(true);
    });

    it("detects 500 internal server error with api_error type in JSON", () => {
      expect(
        isTransientApiError(
          '{"type":"api_error","message":"Internal server error"} 500',
          null,
        ),
      ).toBe(true);
    });

    it("detects 503 temporarily unavailable", () => {
      expect(
        isTransientApiError(
          "503 temporarily unavailable",
          null,
        ),
      ).toBe(true);
    });
  });

  describe("does NOT detect non-transient errors", () => {
    it("returns false for null inputs", () => {
      expect(isTransientApiError(null, null)).toBe(false);
    });

    it("returns false for empty strings", () => {
      expect(isTransientApiError("", "")).toBe(false);
    });

    it("returns false for authentication errors", () => {
      expect(
        isTransientApiError("API Error: 401 Unauthorized", null),
      ).toBe(false);
    });

    it("returns false for rate limit errors (429)", () => {
      expect(
        isTransientApiError("API Error: 429 Too Many Requests", null),
      ).toBe(false);
    });

    it("returns false for generic adapter failures", () => {
      expect(
        isTransientApiError("Adapter failed: process exited with code 1", null),
      ).toBe(false);
    });

    it("returns false for timeout errors", () => {
      expect(
        isTransientApiError("Timed out after 300 seconds", null),
      ).toBe(false);
    });

    it("returns false for permission errors", () => {
      expect(
        isTransientApiError("API Error: 403 Forbidden", null),
      ).toBe(false);
    });

    it("returns false for invalid request errors", () => {
      expect(
        isTransientApiError(
          '{"type":"invalid_request_error","message":"max_tokens must be positive"}',
          null,
        ),
      ).toBe(false);
    });
  });
});
