import { describe, expect, it } from "vitest";
import { MAX_HTTP_TIMEOUT_MS, resolveHttpTimeoutMs } from "./timeout.js";

describe("resolveHttpTimeoutMs", () => {
  it("converts the documented timeoutSec field to milliseconds", () => {
    expect(resolveHttpTimeoutMs({ timeoutSec: 2 })).toBe(2000);
  });

  it("prefers timeoutMs when both fields hold a number", () => {
    expect(resolveHttpTimeoutMs({ timeoutMs: 1000, timeoutSec: 9 })).toBe(1000);
  });

  it("falls through to timeoutSec when timeoutMs is present but unusable", () => {
    // `adapterConfig` holds arbitrary JSON, so the alias can be present and
    // still carry no number. The documented field then supplies the timeout.
    expect(resolveHttpTimeoutMs({ timeoutMs: null, timeoutSec: 5 })).toBe(5000);
    expect(resolveHttpTimeoutMs({ timeoutMs: "1000", timeoutSec: 5 })).toBe(5000);
  });

  it("arms no timeout for a missing, unusable or non-positive value", () => {
    expect(resolveHttpTimeoutMs({})).toBe(0);
    expect(resolveHttpTimeoutMs({ timeoutSec: "2" })).toBe(0);
    expect(resolveHttpTimeoutMs({ timeoutSec: 0 })).toBe(0);
    expect(resolveHttpTimeoutMs({ timeoutSec: -5 })).toBe(0);
    expect(resolveHttpTimeoutMs({ timeoutMs: Number.NaN })).toBe(0);
  });

  it("holds an oversized timeout at Node's timer ceiling", () => {
    // Node coerces a delay beyond a 32-bit signed integer to 1ms, which would
    // abort the request at once rather than after the configured wait.
    expect(resolveHttpTimeoutMs({ timeoutSec: 3_000_000_000 })).toBe(MAX_HTTP_TIMEOUT_MS);
    expect(resolveHttpTimeoutMs({ timeoutMs: Number.MAX_VALUE })).toBe(MAX_HTTP_TIMEOUT_MS);
    expect(MAX_HTTP_TIMEOUT_MS).toBeLessThanOrEqual(2 ** 31 - 1);
  });

  it("floors a fractional millisecond value", () => {
    expect(resolveHttpTimeoutMs({ timeoutSec: 0.0015 })).toBe(1);
  });

  it("holds a positive sub-millisecond timeout at 1ms", () => {
    // Flooring must not turn a configured timeout into the no-timeout
    // sentinel, which would leave a stalled request unbounded.
    expect(resolveHttpTimeoutMs({ timeoutSec: 0.0005 })).toBe(1);
    expect(resolveHttpTimeoutMs({ timeoutMs: 0.4 })).toBe(1);
  });
});
