import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { categorizeOnboardingError } from "./onboarding-error";

describe("categorizeOnboardingError", () => {
  describe("ApiError → 5xx", () => {
    it("classifies 500 with generic body as unknown_server_error", () => {
      const err = new ApiError("Internal server error", 500, {
        error: "Internal server error",
      });
      const result = categorizeOnboardingError(err);
      expect(result.class).toBe("unknown_server_error");
      expect(result.status).toBe(500);
      expect(result.serverMessage).toBe("Internal server error");
      expect(result.incidentId).toBeNull();
      expect(result.fields).toEqual([]);
    });

    it("extracts incidentId from a 500 body when present", () => {
      const err = new ApiError("Internal server error", 503, {
        error: "Internal server error",
        incidentId: "PAP-9012",
      });
      const result = categorizeOnboardingError(err);
      expect(result.class).toBe("unknown_server_error");
      expect(result.incidentId).toBe("PAP-9012");
    });

    it("accepts issueIdentifier alias for incidentId", () => {
      const err = new ApiError("Internal server error", 500, {
        error: "Internal server error",
        issueIdentifier: "GST-99",
      });
      const result = categorizeOnboardingError(err);
      expect(result.incidentId).toBe("GST-99");
    });
  });

  describe("ApiError → 409", () => {
    it("classifies 409 as name_conflict", () => {
      const err = new ApiError(
        "Agent shortname 'CEO' is already in use in this company",
        409,
        { error: "Agent shortname 'CEO' is already in use in this company" },
      );
      const result = categorizeOnboardingError(err);
      expect(result.class).toBe("name_conflict");
      expect(result.status).toBe(409);
      expect(result.serverMessage).toBe(
        "Agent shortname 'CEO' is already in use in this company",
      );
    });
  });

  describe("ApiError → 4xx validation", () => {
    it("classifies 400 with Zod details as validation and extracts fields", () => {
      const err = new ApiError("Validation error", 400, {
        error: "Validation error",
        details: [
          { path: ["name"], message: "Required", code: "invalid_type" },
          { path: ["budget", "monthlyCents"], message: "Must be positive" },
        ],
      });
      const result = categorizeOnboardingError(err);
      expect(result.class).toBe("validation");
      expect(result.status).toBe(400);
      expect(result.fields).toEqual([
        { path: "name", message: "Required" },
        { path: "budget.monthlyCents", message: "Must be positive" },
      ]);
    });

    it("treats 422 with no details as validation but with empty fields", () => {
      const err = new ApiError("Cannot create", 422, { error: "Cannot create" });
      const result = categorizeOnboardingError(err);
      expect(result.class).toBe("validation");
      expect(result.fields).toEqual([]);
    });

    it("skips Zod entries that have no message", () => {
      const err = new ApiError("Validation error", 400, {
        error: "Validation error",
        details: [
          { path: ["a"] },
          { path: ["b"], message: "Bad" },
          "not-a-record",
        ],
      });
      const result = categorizeOnboardingError(err);
      expect(result.fields).toEqual([{ path: "b", message: "Bad" }]);
    });
  });

  describe("Network", () => {
    it("classifies a TypeError with 'Failed to fetch' as network (Chrome)", () => {
      const err = new TypeError("Failed to fetch");
      const result = categorizeOnboardingError(err);
      expect(result.class).toBe("network");
      expect(result.status).toBeNull();
      expect(result.serverMessage).toBe("Failed to fetch");
    });

    it("classifies a TypeError with 'NetworkError' as network (Firefox)", () => {
      const err = new TypeError("NetworkError when attempting to fetch resource.");
      const result = categorizeOnboardingError(err);
      expect(result.class).toBe("network");
    });

    it("classifies a TypeError with 'Load failed' as network (Safari)", () => {
      const err = new TypeError("Load failed");
      const result = categorizeOnboardingError(err);
      expect(result.class).toBe("network");
    });

    it("classifies an aborted DOMException as network", () => {
      const err = new DOMException("aborted", "AbortError");
      const result = categorizeOnboardingError(err);
      expect(result.class).toBe("network");
    });
  });

  describe("Catch-all", () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      consoleErrorSpy.mockRestore();
    });

    it("classifies an unknown Error as unknown_server_error", () => {
      const err = new Error("boom");
      const result = categorizeOnboardingError(err);
      expect(result.class).toBe("unknown_server_error");
      expect(result.serverMessage).toBe("boom");
    });

    it("handles non-Error throws without crashing", () => {
      const result = categorizeOnboardingError("string-thrown");
      expect(result.class).toBe("unknown_server_error");
      expect(result.serverMessage).toBeNull();
      expect(result.fields).toEqual([]);
    });

    it("classifies a non-network TypeError (JS bug) as unknown_server_error", () => {
      const err = new TypeError("Cannot read properties of null (reading 'foo')");
      const result = categorizeOnboardingError(err);
      expect(result.class).toBe("unknown_server_error");
      expect(result.serverMessage).toBe(
        "Cannot read properties of null (reading 'foo')",
      );
    });

    it("logs uncategorized errors via console.error so the 'We've logged it' copy is honest", () => {
      const err = new Error("boom");
      categorizeOnboardingError(err);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[onboarding] uncategorized error",
        err,
      );
    });

    it("logs non-fetch TypeErrors that fall through to the catch-all", () => {
      const err = new TypeError("Cannot read properties of null");
      categorizeOnboardingError(err);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[onboarding] uncategorized error",
        err,
      );
    });

    it("does not log when the error is correctly classified as network", () => {
      categorizeOnboardingError(new TypeError("Failed to fetch"));
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });
  });

  describe("Never leaks raw err.message into the unknown_server_error body field", () => {
    it("keeps the categorized class invariant even when server returns weird body shapes", () => {
      const err = new ApiError("oops", 500, "not-json");
      const result = categorizeOnboardingError(err);
      expect(result.class).toBe("unknown_server_error");
      // serverMessage falls back to ApiError.message when body is not a record
      expect(result.serverMessage).toBe("oops");
      expect(result.incidentId).toBeNull();
    });
  });
});
