import { describe, expect, it } from "vitest";
import {
  asFiniteNumber,
  formatCents,
  formatDurationMs,
  formatNumber,
  formatTokens,
} from "./utils";

// #14429: a fresh workspace (zero completed runs) can produce a summary whose
// derived numbers are null/undefined/NaN/Infinity. The metric formatters used
// by the dashboard MetricCards must coerce those to 0 instead of crashing
// (`undefined.toLocaleString`) or rendering "$NaN" / "NaN%" / "Infinity".
describe("metric formatters with degenerate payloads", () => {
  it("formatCents returns $0.00 for non-finite cents and is unchanged otherwise", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(123456)).toBe("$1,234.56");
    expect(formatCents(null as unknown as number)).toBe("$0.00");
    expect(formatCents(undefined as unknown as number)).toBe("$0.00");
    expect(formatCents(NaN)).toBe("$0.00");
    expect(formatCents(Infinity)).toBe("$0.00");
  });

  it("formatNumber returns 0 for non-finite values instead of throwing", () => {
    expect(formatNumber(1234567)).toBe("1,234,567");
    expect(() => formatNumber(undefined as unknown as number)).not.toThrow();
    expect(formatNumber(undefined as unknown as number)).toBe("0");
    expect(formatNumber(NaN)).toBe("0");
    expect(formatNumber(Infinity)).toBe("0");
  });

  it("formatTokens returns 0 for non-finite token counts", () => {
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(NaN)).toBe("0");
    expect(formatTokens(undefined as unknown as number)).toBe("0");
  });

  it("formatDurationMs keeps its existing non-finite fallback", () => {
    expect(formatDurationMs(NaN)).toBe("0s");
    expect(formatDurationMs(Infinity)).toBe("0s");
    expect(formatDurationMs(90_000)).toBe("1m 30s");
  });

  it("asFiniteNumber falls back for non-finite dashboard utilization", () => {
    expect(asFiniteNumber(42.5, 0)).toBe(42.5);
    expect(asFiniteNumber(null, 0)).toBe(0);
    expect(asFiniteNumber(Infinity, 0)).toBe(0);
  });
});
