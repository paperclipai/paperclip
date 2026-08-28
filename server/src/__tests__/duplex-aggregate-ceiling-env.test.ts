import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MAX_AGGREGATE_DUPLEX_ROUTE_BYTES } from "@paperclipai/adapter-utils/duplex-aggregate-byte-ledger";
import { resolveDuplexAggregateCeilingBytesFromEnv } from "../duplex-aggregate-ceiling-env.js";

describe("resolveDuplexAggregateCeilingBytesFromEnv", () => {
  it("uses the safe default and reports nothing when the variable is absent", () => {
    const onRejectedOverride = vi.fn();

    const resolved = resolveDuplexAggregateCeilingBytesFromEnv(undefined, onRejectedOverride);

    expect(resolved).toBe(DEFAULT_MAX_AGGREGATE_DUPLEX_ROUTE_BYTES);
    expect(onRejectedOverride).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only value as a present invalid override, not as absent", () => {
    const rawOverride = "   ";
    const onRejectedOverride = vi.fn();

    // The resolver must continue with the safe default. Startup does not fail.
    const resolved = resolveDuplexAggregateCeilingBytesFromEnv(rawOverride, onRejectedOverride);

    expect(resolved).toBe(DEFAULT_MAX_AGGREGATE_DUPLEX_ROUTE_BYTES);
    // The rejection reporter fires one time. A blank value is now visible as
    // invalid instead of silent as absent.
    expect(onRejectedOverride).toHaveBeenCalledTimes(1);
    // The reporter receives only the parsed number. The raw whitespace string
    // never reaches the reporter, so no operator-supplied text can reach a log
    // line.
    const reportedValue = onRejectedOverride.mock.calls[0]?.[0];
    expect(typeof reportedValue).toBe("number");
    expect(reportedValue).not.toBe(rawOverride);
    expect(Number.isFinite(reportedValue)).toBe(true);
  });

  it("treats an empty-string value as a present invalid override", () => {
    const onRejectedOverride = vi.fn();

    const resolved = resolveDuplexAggregateCeilingBytesFromEnv("", onRejectedOverride);

    expect(resolved).toBe(DEFAULT_MAX_AGGREGATE_DUPLEX_ROUTE_BYTES);
    expect(onRejectedOverride).toHaveBeenCalledTimes(1);
  });

  it("rejects a present non-numeric value and uses the safe default", () => {
    const onRejectedOverride = vi.fn();

    const resolved = resolveDuplexAggregateCeilingBytesFromEnv("not-a-number", onRejectedOverride);

    expect(resolved).toBe(DEFAULT_MAX_AGGREGATE_DUPLEX_ROUTE_BYTES);
    expect(onRejectedOverride).toHaveBeenCalledTimes(1);
  });

  it("passes a valid override through unchanged", () => {
    const onRejectedOverride = vi.fn();

    const resolved = resolveDuplexAggregateCeilingBytesFromEnv("1048576", onRejectedOverride);

    expect(resolved).toBe(1048576);
    expect(onRejectedOverride).not.toHaveBeenCalled();
  });

  it("accepts a valid override that carries surrounding whitespace", () => {
    const onRejectedOverride = vi.fn();

    const resolved = resolveDuplexAggregateCeilingBytesFromEnv("  1048576  ", onRejectedOverride);

    expect(resolved).toBe(1048576);
    expect(onRejectedOverride).not.toHaveBeenCalled();
  });
});
