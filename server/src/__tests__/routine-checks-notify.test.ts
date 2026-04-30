import { describe, it, expect } from "vitest";
import {
  shouldNotify,
  buildSummary,
  computeContentHash,
} from "../services/routine-checks/notify.ts";

describe("shouldNotify", () => {
  it("silent + stable ok → no notify", () => {
    expect(shouldNotify({ channel: "silent", currentStatus: "ok", previousStatus: "ok", findings: 0 })).toBe(false);
  });

  it("silent + first-run warn → no notify (no recovery context)", () => {
    expect(shouldNotify({ channel: "silent", currentStatus: "warn", previousStatus: null, findings: 1 })).toBe(false);
  });

  it("silent + state-change error→ok → notify (recovery)", () => {
    expect(shouldNotify({ channel: "silent", currentStatus: "ok", previousStatus: "error", findings: 0 })).toBe(true);
  });

  it("silent + state-change warn→ok → notify (recovery)", () => {
    expect(shouldNotify({ channel: "silent", currentStatus: "ok", previousStatus: "warn", findings: 0 })).toBe(true);
  });

  it("silent + state-change ok→warn → no notify", () => {
    expect(shouldNotify({ channel: "silent", currentStatus: "warn", previousStatus: "ok", findings: 1 })).toBe(false);
  });

  it("threshold(warn) + warn (state-change) → notify", () => {
    expect(shouldNotify({ channel: "threshold", thresholdSeverity: "warn", currentStatus: "warn", previousStatus: "ok", findings: 1 })).toBe(true);
  });

  it("threshold(warn) + ok stable → no notify", () => {
    expect(shouldNotify({ channel: "threshold", thresholdSeverity: "warn", currentStatus: "ok", previousStatus: "ok", findings: 0 })).toBe(false);
  });

  it("threshold(warn) + state-change warn→ok → notify (recovery)", () => {
    expect(shouldNotify({ channel: "threshold", thresholdSeverity: "warn", currentStatus: "ok", previousStatus: "warn", findings: 0 })).toBe(true);
  });

  it("threshold(error) + warn → no notify (below severity)", () => {
    expect(shouldNotify({ channel: "threshold", thresholdSeverity: "error", currentStatus: "warn", previousStatus: "warn", findings: 1 })).toBe(false);
  });

  it("threshold(error) + error stable → notify (meets severity)", () => {
    expect(shouldNotify({ channel: "threshold", thresholdSeverity: "error", currentStatus: "error", previousStatus: "error", findings: 0 })).toBe(true);
  });

  it("telegram + findings=0 stable → no notify", () => {
    expect(shouldNotify({ channel: "telegram", currentStatus: "ok", previousStatus: "ok", findings: 0 })).toBe(false);
  });

  it("telegram + findings>0 → notify", () => {
    expect(shouldNotify({ channel: "telegram", currentStatus: "warn", previousStatus: "warn", findings: 5 })).toBe(true);
  });

  it("telegram + findings=0 with state-change → notify", () => {
    expect(shouldNotify({ channel: "telegram", currentStatus: "ok", previousStatus: "warn", findings: 0 })).toBe(true);
  });
});

describe("buildSummary", () => {
  it("prefixes recovery on warn→ok", () => {
    expect(buildSummary({ original: "all clean", previousStatus: "warn", currentStatus: "ok" })).toBe("✅ recovery — all clean");
  });

  it("prefixes recovery on error→ok", () => {
    expect(buildSummary({ original: "restored", previousStatus: "error", currentStatus: "ok" })).toBe("✅ recovery — restored");
  });

  it("passes through on stable warn", () => {
    expect(buildSummary({ original: "3 drift", previousStatus: "warn", currentStatus: "warn" })).toBe("3 drift");
  });

  it("passes through on first-run", () => {
    expect(buildSummary({ original: "hello", previousStatus: null, currentStatus: "ok" })).toBe("hello");
  });

  it("passes through on first-run warn", () => {
    expect(buildSummary({ original: "hello", previousStatus: null, currentStatus: "warn" })).toBe("hello");
  });
});

describe("computeContentHash", () => {
  it("returns deterministic sha256 prefix", () => {
    const a = computeContentHash({ summary: "x", findings: 1, examples: ["a", "b", "c"] });
    const b = computeContentHash({ summary: "x", findings: 1, examples: ["a", "b", "c"] });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256-[0-9a-f]{32}$/);
  });

  it("changes when examples change", () => {
    const a = computeContentHash({ summary: "x", findings: 1, examples: ["a"] });
    const b = computeContentHash({ summary: "x", findings: 1, examples: ["b"] });
    expect(a).not.toBe(b);
  });

  it("uses only top-3 examples", () => {
    const a = computeContentHash({ summary: "x", findings: 1, examples: ["a", "b", "c"] });
    const b = computeContentHash({ summary: "x", findings: 1, examples: ["a", "b", "c", "d", "e"] });
    expect(a).toBe(b);
  });

  it("changes when findings change", () => {
    const a = computeContentHash({ summary: "x", findings: 1, examples: [] });
    const b = computeContentHash({ summary: "x", findings: 2, examples: [] });
    expect(a).not.toBe(b);
  });

  it("changes when summary changes", () => {
    const a = computeContentHash({ summary: "x", findings: 0, examples: [] });
    const b = computeContentHash({ summary: "y", findings: 0, examples: [] });
    expect(a).not.toBe(b);
  });
});
