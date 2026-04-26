import { describe, it, expect } from "vitest";
import { formatTextResponse, formatErrorResponse } from "./format.js";
import { normalizeApiUrl, readConfigFromEnv } from "./config.js";
import { PaperclipApiError } from "./client.js";

// ============================================================================
// format.ts — formatTextResponse
// ============================================================================

describe("formatTextResponse", () => {
  it("wraps a string value in MCP text content", () => {
    const result = formatTextResponse("hello");
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toBe("hello");
  });

  it("JSON-serializes a non-string value", () => {
    const result = formatTextResponse({ key: "value" });
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toEqual({ key: "value" });
  });

  it("JSON-serializes an array", () => {
    const result = formatTextResponse([1, 2, 3]);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toEqual([1, 2, 3]);
  });

  it("JSON-serializes null", () => {
    const result = formatTextResponse(null);
    expect(result.content[0]?.text).toBe("null");
  });

  it("JSON-serializes a number", () => {
    const result = formatTextResponse(42);
    expect(result.content[0]?.text).toBe("42");
  });
});

// ============================================================================
// format.ts — formatErrorResponse
// ============================================================================

describe("formatErrorResponse", () => {
  it("formats a generic Error by message", () => {
    const result = formatErrorResponse(new Error("something failed"));
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.error).toBe("something failed");
  });

  it("formats a PaperclipApiError with full details", () => {
    const err = new PaperclipApiError({
      message: "Not Found",
      status: 404,
      method: "GET",
      path: "/issues/999",
      body: null,
    });
    const result = formatErrorResponse(err);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.error).toBe("Not Found");
    expect(parsed.status).toBe(404);
    expect(parsed.method).toBe("GET");
    expect(parsed.path).toBe("/issues/999");
  });

  it("formats a non-Error value via String()", () => {
    const result = formatErrorResponse("raw string error");
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.error).toBe("raw string error");
  });
});

// ============================================================================
// config.ts — normalizeApiUrl
// ============================================================================

describe("normalizeApiUrl", () => {
  it("appends /api when not present", () => {
    expect(normalizeApiUrl("http://localhost:3000")).toBe("http://localhost:3000/api");
  });

  it("does not double-append /api when already present", () => {
    expect(normalizeApiUrl("http://localhost:3000/api")).toBe("http://localhost:3000/api");
  });

  it("strips trailing slashes", () => {
    expect(normalizeApiUrl("http://localhost:3000/")).toBe("http://localhost:3000/api");
    expect(normalizeApiUrl("http://localhost:3000///")).toBe("http://localhost:3000/api");
  });

  it("strips trailing slashes from a URL that already has /api/", () => {
    expect(normalizeApiUrl("http://localhost:3000/api/")).toBe("http://localhost:3000/api");
  });

  it("trims leading/trailing whitespace from the URL", () => {
    expect(normalizeApiUrl("  http://localhost:3000  ")).toBe("http://localhost:3000/api");
  });
});

// ============================================================================
// config.ts — readConfigFromEnv
// ============================================================================

describe("readConfigFromEnv", () => {
  const baseEnv = {
    PAPERCLIP_API_URL: "http://localhost:3000",
    PAPERCLIP_API_KEY: "token-abc",
  } as NodeJS.ProcessEnv;

  it("reads required fields from environment", () => {
    const config = readConfigFromEnv(baseEnv);
    expect(config.apiUrl).toBe("http://localhost:3000/api");
    expect(config.apiKey).toBe("token-abc");
  });

  it("returns null for optional fields when not set", () => {
    const config = readConfigFromEnv(baseEnv);
    expect(config.companyId).toBeNull();
    expect(config.agentId).toBeNull();
    expect(config.runId).toBeNull();
  });

  it("reads optional fields when provided", () => {
    const config = readConfigFromEnv({
      ...baseEnv,
      PAPERCLIP_COMPANY_ID: "co-1",
      PAPERCLIP_AGENT_ID: "agent-1",
      PAPERCLIP_RUN_ID: "run-1",
    } as NodeJS.ProcessEnv);
    expect(config.companyId).toBe("co-1");
    expect(config.agentId).toBe("agent-1");
    expect(config.runId).toBe("run-1");
  });

  it("throws when PAPERCLIP_API_URL is missing", () => {
    expect(() =>
      readConfigFromEnv({ PAPERCLIP_API_KEY: "key" } as NodeJS.ProcessEnv)
    ).toThrow(/PAPERCLIP_API_URL/);
  });

  it("throws when PAPERCLIP_API_KEY is missing", () => {
    expect(() =>
      readConfigFromEnv({ PAPERCLIP_API_URL: "http://x" } as NodeJS.ProcessEnv)
    ).toThrow(/PAPERCLIP_API_KEY/);
  });

  it("treats whitespace-only values as missing", () => {
    expect(() =>
      readConfigFromEnv({
        PAPERCLIP_API_URL: "   ",
        PAPERCLIP_API_KEY: "key",
      } as NodeJS.ProcessEnv)
    ).toThrow(/PAPERCLIP_API_URL/);
  });
});
