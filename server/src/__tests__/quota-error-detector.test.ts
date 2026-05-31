import { describe, expect, it } from "vitest";
import { detectQuotaError, DEFAULT_QUOTA_COOLDOWN_MS } from "../services/quota-error-detector.ts";

describe("detectQuotaError", () => {
  it("returns isQuotaExhausted=false for a generic error", () => {
    const result = detectQuotaError("context window exceeded");
    expect(result.isQuotaExhausted).toBe(false);
    expect(result.cooldownMs).toBe(0);
  });

  it("detects QUOTA_EXHAUSTED (case-insensitive)", () => {
    const result = detectQuotaError("QUOTA_EXHAUSTED: daily limit reached");
    expect(result.isQuotaExhausted).toBe(true);
    expect(result.cooldownMs).toBe(DEFAULT_QUOTA_COOLDOWN_MS);
  });

  it("detects RESOURCE_EXHAUSTED", () => {
    const result = detectQuotaError("429 RESOURCE_EXHAUSTED: model capacity");
    expect(result.isQuotaExhausted).toBe(true);
  });

  it("detects TerminalQuotaError", () => {
    const result = detectQuotaError("TerminalQuotaError on gemini-2.5-flash");
    expect(result.isQuotaExhausted).toBe(true);
  });

  it("detects 'capacity on this model'", () => {
    const result = detectQuotaError("HTTP 429: no capacity on this model right now");
    expect(result.isQuotaExhausted).toBe(true);
  });

  it("detects 'quota exceeded' phrase", () => {
    const result = detectQuotaError("Your quota exceeded the daily limit");
    expect(result.isQuotaExhausted).toBe(true);
  });

  it("parses retry-after hint from 'retry after N seconds'", () => {
    const result = detectQuotaError("QUOTA_EXHAUSTED — retry after 300 seconds");
    expect(result.isQuotaExhausted).toBe(true);
    expect(result.cooldownMs).toBe(300_000);
  });

  it("parses retryDelay hint from Gemini format", () => {
    const result = detectQuotaError('RESOURCE_EXHAUSTED retryDelay: "3600s"');
    expect(result.isQuotaExhausted).toBe(true);
    expect(result.cooldownMs).toBe(3_600_000);
  });

  it("reason string includes the error message prefix", () => {
    const result = detectQuotaError("QUOTA_EXHAUSTED: some detail");
    expect(result.reason).toMatch(/^quota_exhausted:/);
    expect(result.reason).toContain("QUOTA_EXHAUSTED");
  });
});
