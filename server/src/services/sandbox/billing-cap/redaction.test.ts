import { describe, expect, it } from "vitest";
import { REDACTED_VENDOR_VALUE, looksLikeCredentialValue, redactCredentialShapedValues } from "./redaction.js";

describe("billing-cap redaction", () => {
  it("detects JWT triple-segment shapes", () => {
    expect(looksLikeCredentialValue("eyJhbGciOiJI.eyJzdWIiOiI.MEUCIQDx-xKK")).toBe(true);
  });
  it("detects e2b-prefixed keys", () => {
    expect(looksLikeCredentialValue("e2b_abc123XYZ456789def")).toBe(true);
  });
  it("detects bearer-prefixed values", () => {
    expect(looksLikeCredentialValue("Bearer abc123XYZ456789defghi")).toBe(true);
  });
  it("does not flag short strings", () => {
    expect(looksLikeCredentialValue("hello world")).toBe(false);
    expect(looksLikeCredentialValue("e2b_short")).toBe(false);
  });
  it("redacts credential-shaped values and named secret keys", () => {
    const input = {
      total_usd: "2.34",
      apiKey: "this_should_redact_via_key_name",
      raw: {
        embedded: "eyJhbGciOiJI.eyJzdWIiOiI.MEUCIQDx-xKK",
        safe: "hello",
      },
      arr: ["e2b_abcdefghijklmnopqr"],
    };
    const result = redactCredentialShapedValues(input);
    expect(result.redactedAny).toBe(true);
    expect((result.value as any).apiKey).toBe(REDACTED_VENDOR_VALUE);
    expect((result.value as any).raw.embedded).toBe(REDACTED_VENDOR_VALUE);
    expect((result.value as any).raw.safe).toBe("hello");
    expect((result.value as any).arr[0]).toBe(REDACTED_VENDOR_VALUE);
    expect(result.redactedPaths).toContain("apiKey");
    expect(result.redactedPaths).toContain("raw.embedded");
  });
  it("returns redactedAny=false for clean payloads", () => {
    const result = redactCredentialShapedValues({ total: 100, currency: "USD" });
    expect(result.redactedAny).toBe(false);
    expect(result.redactedPaths).toEqual([]);
  });
});
