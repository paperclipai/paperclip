import { describe, expect, it } from "vitest";
import { formatTextResponse, formatErrorResponse } from "./format.js";
import { PaperclipApiError } from "./client.js";

// ============================================================================
// formatTextResponse
// ============================================================================

describe("formatTextResponse", () => {
  it("returns a content array with a single text entry", () => {
    const result = formatTextResponse("hello");
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("text");
  });

  it("passes a string value through as-is", () => {
    const result = formatTextResponse("hello world");
    expect(result.content[0]!.text).toBe("hello world");
  });

  it("passes an empty string through as-is", () => {
    const result = formatTextResponse("");
    expect(result.content[0]!.text).toBe("");
  });

  it("JSON.stringifies an object value with 2-space indentation", () => {
    const result = formatTextResponse({ key: "value" });
    expect(result.content[0]!.text).toBe(JSON.stringify({ key: "value" }, null, 2));
  });

  it("JSON.stringifies an array value", () => {
    const result = formatTextResponse([1, 2, 3]);
    expect(result.content[0]!.text).toBe(JSON.stringify([1, 2, 3], null, 2));
  });

  it("JSON.stringifies a number", () => {
    const result = formatTextResponse(42);
    expect(result.content[0]!.text).toBe("42");
  });

  it("JSON.stringifies a boolean", () => {
    const result = formatTextResponse(true);
    expect(result.content[0]!.text).toBe("true");
  });

  it("JSON.stringifies null", () => {
    const result = formatTextResponse(null);
    expect(result.content[0]!.text).toBe("null");
  });

  it("JSON.stringifies undefined (produces undefined string)", () => {
    const result = formatTextResponse(undefined);
    // JSON.stringify(undefined, null, 2) === undefined, so text === undefined
    expect(result.content[0]!.text).toBeUndefined();
  });
});

// ============================================================================
// formatErrorResponse
// ============================================================================

describe("formatErrorResponse — PaperclipApiError", () => {
  it("returns error object with all PaperclipApiError fields", () => {
    const error = new PaperclipApiError({
      status: 404,
      method: "GET",
      path: "/api/issues/123",
      body: { detail: "not found" },
      message: "Issue not found",
    });
    const result = formatErrorResponse(error);
    const text = JSON.parse(result.content[0]!.text);
    expect(text.error).toBe("Issue not found");
    expect(text.status).toBe(404);
    expect(text.method).toBe("GET");
    expect(text.path).toBe("/api/issues/123");
    expect(text.body).toEqual({ detail: "not found" });
  });

  it("includes all required fields in the output JSON", () => {
    const error = new PaperclipApiError({
      status: 500,
      method: "POST",
      path: "/api/checkout",
      body: null,
      message: "Internal error",
    });
    const result = formatErrorResponse(error);
    const text = JSON.parse(result.content[0]!.text);
    expect(text).toHaveProperty("error");
    expect(text).toHaveProperty("status");
    expect(text).toHaveProperty("method");
    expect(text).toHaveProperty("path");
    expect(text).toHaveProperty("body");
  });
});

describe("formatErrorResponse — generic Error", () => {
  it("returns the error message for a standard Error instance", () => {
    const error = new Error("something went wrong");
    const result = formatErrorResponse(error);
    const text = JSON.parse(result.content[0]!.text);
    expect(text.error).toBe("something went wrong");
  });

  it("does not include status or path for a plain Error", () => {
    const error = new Error("oops");
    const result = formatErrorResponse(error);
    const text = JSON.parse(result.content[0]!.text);
    expect(text).not.toHaveProperty("status");
    expect(text).not.toHaveProperty("path");
  });
});

describe("formatErrorResponse — non-Error values", () => {
  it("converts a string to an error object", () => {
    const result = formatErrorResponse("plain error string");
    const text = JSON.parse(result.content[0]!.text);
    expect(text.error).toBe("plain error string");
  });

  it("converts a number via String()", () => {
    const result = formatErrorResponse(42);
    const text = JSON.parse(result.content[0]!.text);
    expect(text.error).toBe("42");
  });

  it("converts an object via String() (produces [object Object])", () => {
    const result = formatErrorResponse({ weird: true });
    const text = JSON.parse(result.content[0]!.text);
    expect(text.error).toBe("[object Object]");
  });

  it("converts null via String()", () => {
    const result = formatErrorResponse(null);
    const text = JSON.parse(result.content[0]!.text);
    expect(text.error).toBe("null");
  });
});
