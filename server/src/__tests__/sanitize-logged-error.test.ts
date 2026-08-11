import { describe, expect, it } from "vitest";
import { sanitizeLoggedProviderError } from "../lib/sanitize-logged-error.js";

describe("sanitizeLoggedProviderError", () => {
  it("passes clean ASCII through unchanged", () => {
    expect(sanitizeLoggedProviderError("invalid_grant: token expired")).toBe("invalid_grant: token expired");
  });

  it("strips control characters", () => {
    expect(sanitizeLoggedProviderError("bad\x00token\x01here\nnow")).toBe("badtokenherenow");
  });

  it("strips CRLF, the canonical log-injection vector", () => {
    expect(sanitizeLoggedProviderError("error\r\nFAKE_AUDIT: admin")).toBe("errorFAKE_AUDIT: admin");
  });

  it("strips non-ASCII bytes", () => {
    expect(sanitizeLoggedProviderError("Ungültiger Token")).toBe("Ungltiger Token");
  });

  it("strips DEL (0x7f)", () => {
    expect(sanitizeLoggedProviderError("del\x7fchar")).toBe("delchar");
  });

  it("passes a string of exactly 512 characters through unchanged", () => {
    const value = "a".repeat(512);
    expect(sanitizeLoggedProviderError(value)).toBe(value);
    expect(sanitizeLoggedProviderError(value)).toHaveLength(512);
  });

  it("truncates a string longer than 512 characters after stripping", () => {
    const value = "b".repeat(600);
    expect(sanitizeLoggedProviderError(value)).toHaveLength(512);
  });

  it("strips before truncating, so stripped bytes don't count against the 512-char budget", () => {
    // If truncation ran first, the leading 300 control bytes (which the 512
    // cap would consume) would leave only 212 of the trailing "a"s standing
    // to be stripped-to-nothing-productive; strip-then-truncate instead
    // yields all 400 "a"s untouched, under the cap with no truncation at all.
    const value = "\x00".repeat(300) + "a".repeat(400);
    expect(sanitizeLoggedProviderError(value)).toBe("a".repeat(400));
    expect(sanitizeLoggedProviderError(value)).toHaveLength(400);
  });

  it("returns an empty string for all-control-character input, without throwing", () => {
    expect(() => sanitizeLoggedProviderError("\x00\x01\x02\x1f")).not.toThrow();
    expect(sanitizeLoggedProviderError("\x00\x01\x02\x1f")).toBe("");
  });

  it("returns an empty string for empty input", () => {
    expect(sanitizeLoggedProviderError("")).toBe("");
  });
});
