import { describe, expect, it } from "vitest";
import { parseRunLogChunkForLiveness } from "../services/recovery/api-retry-parser.ts";

describe("api-retry parser", () => {
  it("treats a pure api_retry chunk as liveness-only", () => {
    const chunk = `${JSON.stringify({ type: "system", subtype: "api_retry", attempt: 2, error_status: "529", error: "Overloaded" })}\n`;
    const parsed = parseRunLogChunkForLiveness(chunk);
    expect(parsed.hasApiRetry).toBe(true);
    expect(parsed.hasNonRetryContent).toBe(false);
    expect(parsed.latestRetry).toEqual({ attempt: 2, errorStatus: "529", errorMessage: "Overloaded" });
  });

  it("captures the latest attempt when multiple api_retry events are batched", () => {
    const chunk = [
      JSON.stringify({ type: "system", subtype: "api_retry", attempt: 1, error_status: "529" }),
      JSON.stringify({ type: "system", subtype: "api_retry", attempt: 4, error_status: "529", error: "Overloaded" }),
    ].join("\n");
    const parsed = parseRunLogChunkForLiveness(chunk);
    expect(parsed.hasApiRetry).toBe(true);
    expect(parsed.hasNonRetryContent).toBe(false);
    expect(parsed.latestRetry).toEqual({ attempt: 4, errorStatus: "529", errorMessage: "Overloaded" });
  });

  it("flags non-retry content even when api_retry events are interleaved", () => {
    const chunk = [
      JSON.stringify({ type: "system", subtype: "api_retry", attempt: 1 }),
      "tool: writing file",
      JSON.stringify({ type: "system", subtype: "api_retry", attempt: 2 }),
    ].join("\n");
    const parsed = parseRunLogChunkForLiveness(chunk);
    expect(parsed.hasApiRetry).toBe(true);
    expect(parsed.hasNonRetryContent).toBe(true);
    expect(parsed.latestRetry?.attempt).toBe(2);
  });

  it("treats other system events as non-retry content", () => {
    const chunk = `${JSON.stringify({ type: "system", subtype: "init" })}\n`;
    const parsed = parseRunLogChunkForLiveness(chunk);
    expect(parsed.hasApiRetry).toBe(false);
    expect(parsed.hasNonRetryContent).toBe(true);
    expect(parsed.latestRetry).toBeNull();
  });

  it("treats unparseable content as non-retry liveness", () => {
    const chunk = `tool: running build\nstep complete\n`;
    const parsed = parseRunLogChunkForLiveness(chunk);
    expect(parsed.hasApiRetry).toBe(false);
    expect(parsed.hasNonRetryContent).toBe(true);
  });

  it("handles empty chunks safely", () => {
    expect(parseRunLogChunkForLiveness("")).toEqual({
      hasApiRetry: false,
      hasNonRetryContent: false,
      latestRetry: null,
    });
    expect(parseRunLogChunkForLiveness("\n\n  \n")).toEqual({
      hasApiRetry: false,
      hasNonRetryContent: false,
      latestRetry: null,
    });
  });
});
