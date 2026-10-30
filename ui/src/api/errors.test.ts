import { describe, expect, it } from "vitest";
import { ApiError } from "./client";
import {
  apiErrorMessage,
  classifyError,
  describeError,
  errorCodes,
  isConnectivityError,
  isRawErrorCode,
  parseRetryAfter,
  type ErrorKind,
} from "./errors";
import { ApiUnavailableError } from "./response";

function apiError(status: number, body: unknown = null) {
  return new ApiError(apiErrorMessage(status, body), status, body);
}

describe("classifyError", () => {
  it.each<[string, unknown, ErrorKind]>([
    ["a browser network failure", new TypeError("Failed to fetch"), "transient"],
    ["a Safari network failure", new TypeError("Load failed"), "transient"],
    ["a proxy HTML page", new ApiUnavailableError(502), "transient"],
    ["408", apiError(408), "transient"],
    ["425", apiError(425), "transient"],
    ["429", apiError(429, { error: "Too many requests" }), "transient"],
    ["502", apiError(502), "transient"],
    ["503", apiError(503, { error: "Service unavailable" }), "transient"],
    ["504", apiError(504), "transient"],
    ["401", apiError(401, { error: "Unauthorized" }), "auth"],
    ["403", apiError(403, { error: "Forbidden" }), "forbidden"],
    ["404", apiError(404, { error: "Issue not found" }), "not_found"],
    ["410", apiError(410), "not_found"],
    ["409", apiError(409, { error: "Document is locked" }), "conflict"],
    ["412", apiError(412), "conflict"],
    ["400", apiError(400, { error: "Title is required" }), "invalid"],
    ["422", apiError(422), "invalid"],
    ["500", apiError(500, { error: "boom" }), "unknown"],
    ["an abort", new DOMException("Aborted", "AbortError"), "aborted"],
    ["a programming TypeError", new TypeError("Cannot read properties of undefined"), "unknown"],
    ["a plain Error", new Error("nope"), "unknown"],
    ["undefined", undefined, "unknown"],
  ])("classifies %s", (_label, error, kind) => {
    expect(classifyError(error)).toBe(kind);
  });

  it.each([200, 400, 403, 404, 409, 500])(
    "treats the gateway's tenant_app_unavailable as transient in any status (%s)",
    (status) => {
      expect(classifyError(apiError(status, { error: "tenant_app_unavailable" }))).toBe("transient");
      expect(classifyError(apiError(status, { error: "tenant_app_starting" }))).toBe("transient");
    },
  );

  it.each(["WORKER_UNAVAILABLE", "TIMEOUT"])("treats plugin bridge %s as transient", (code) => {
    expect(classifyError(apiError(500, { code, message: "Plugin worker is restarting" }))).toBe("transient");
  });

  it("reads a code from details, as HttpErrors serialize it", () => {
    const error = apiError(409, { error: "Locked", details: { code: "tenant_app_starting" } });
    expect(classifyError(error)).toBe("transient");
  });

  it("classifies structurally, without the ApiError class", () => {
    expect(classifyError({ status: 503, body: null })).toBe("transient");
    expect(classifyError({ name: "AuthApiError", status: 401, code: null })).toBe("auth");
  });
});

describe("isConnectivityError", () => {
  it("is true for server-wide outages only", () => {
    expect(isConnectivityError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isConnectivityError(new ApiUnavailableError(200))).toBe(true);
    expect(isConnectivityError(apiError(503))).toBe(true);
    expect(isConnectivityError(apiError(404, { error: "tenant_app_unavailable" }))).toBe(true);
    // Transient, but one route: left to query retry, not the app banner.
    expect(isConnectivityError(apiError(429))).toBe(false);
    expect(isConnectivityError(apiError(503, { code: "WORKER_UNAVAILABLE", message: "x" }))).toBe(false);
    expect(isConnectivityError(apiError(500))).toBe(false);
    expect(isConnectivityError(apiError(403))).toBe(false);
  });
});

describe("describeError", () => {
  const rawCode = /\b[a-z]+(?:_[a-z]+)+\b|\b[A-Z]+_[A-Z]+\b/;

  it("never returns a raw code", () => {
    const errors = [
      apiError(503, { error: "tenant_app_unavailable" }),
      apiError(200, { error: "tenant_app_starting" }),
      apiError(404, { error: "issue_not_found" }),
      apiError(500, { error: "internal_error" }),
      apiError(503, { code: "WORKER_UNAVAILABLE", message: "WORKER_UNAVAILABLE" }),
      new ApiError("tenant_app_unavailable", 503, { error: "tenant_app_unavailable" }),
    ];
    for (const error of errors) {
      const { title, body } = describeError(error);
      expect(title).not.toMatch(rawCode);
      expect(body).not.toMatch(rawCode);
    }
  });

  it("uses the shared transient copy for outages", () => {
    expect(describeError(new ApiUnavailableError(502))).toEqual({
      title: "Connection interrupted",
      body: "Paperclip is temporarily unavailable. Please try again in a moment.",
      retryable: true,
    });
    expect(describeError(apiError(503, { error: "tenant_app_unavailable" }))).toMatchObject({
      title: "Reconnecting to Paperclip",
      retryable: true,
    });
  });

  it("keeps a readable server message for client errors", () => {
    expect(describeError(apiError(400, { error: "Title is required" }))).toEqual({
      title: "Check your input",
      body: "Title is required",
      retryable: false,
    });
  });

  it("falls back to the kind's copy when the server sent a code or nothing", () => {
    expect(describeError(apiError(404, { error: "issue_not_found" })).body).toBe("This item doesn’t exist or was moved.");
    expect(describeError(apiError(403, null))).toMatchObject({ title: "Not allowed", retryable: false });
    expect(describeError(new Error("Something odd"))).toMatchObject({ body: "Something odd", retryable: true });
    expect(describeError(undefined)).toMatchObject({ title: "Something went wrong", retryable: true });
  });

  it("names the action in the title for real failures, not outages", () => {
    expect(describeError(apiError(409, { error: "Document is locked" }), { action: "save the document" })).toEqual({
      title: "Couldn't save the document",
      body: "Document is locked",
      retryable: false,
    });
    expect(describeError(apiError(503), { action: "save the document" }).title).toBe("Connection interrupted");
  });
});

describe("ApiError", () => {
  it("keeps the raw body.error as code and a readable message", () => {
    const error = apiError(503, { error: "tenant_app_unavailable" });
    expect(error.code).toBe("tenant_app_unavailable");
    expect(error.message).toBe("Paperclip is restarting or updating. Please try again in a moment.");
  });

  it("passes a readable server message through unchanged", () => {
    const error = apiError(409, { error: "Document is locked" });
    expect(error.code).toBe("Document is locked");
    expect(error.message).toBe("Document is locked");
  });

  it("replaces the generic status line with readable copy", () => {
    expect(apiError(404).message).toBe("This item doesn’t exist or was moved.");
    expect(apiError(404).code).toBeNull();
  });

  it("exposes every code for matching", () => {
    expect(errorCodes(apiError(403, { error: "Denied", code: "interaction_human_only", details: { code: "x_y" } })))
      .toEqual(["Denied", "interaction_human_only", "x_y"]);
  });
});

describe("isRawErrorCode", () => {
  it.each(["tenant_app_unavailable", "WORKER_UNAVAILABLE", "TIMEOUT", "issue.not_found"])("%s is a code", (value) => {
    expect(isRawErrorCode(value)).toBe(true);
  });

  it.each(["Forbidden", "Unauthorized", "Document is locked", "Request failed: 503", ""])("%s is not a code", (value) => {
    expect(isRawErrorCode(value)).toBe(false);
  });
});

describe("parseRetryAfter", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfter("5")).toBe(5_000);
    expect(parseRetryAfter(" 1.5 ")).toBe(1_500);
  });

  it("parses an HTTP date relative to now", () => {
    const now = Date.parse("2026-10-09T12:00:00Z");
    expect(parseRetryAfter("Fri, 09 Oct 2026 12:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfter("Fri, 09 Oct 2026 11:00:00 GMT", now)).toBe(0);
  });

  it("caps absurd values and ignores garbage", () => {
    expect(parseRetryAfter("86400")).toBe(5 * 60_000);
    expect(parseRetryAfter("soon")).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});
