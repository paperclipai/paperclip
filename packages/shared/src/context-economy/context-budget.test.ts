import { describe, expect, it } from "vitest";
import {
  COMPACT_STATE_MAX_CHARS,
  detectLargeHistory,
  evaluateHardCeiling,
  preserveCompactState,
  RUN_BUDGET_TURNS,
  shouldCompact,
} from "./context-budget.js";

describe("context-budget", () => {
  it("reuses KOMAA-167 tiers", () => {
    expect(RUN_BUDGET_TURNS).toEqual({ normal: 4, debug: 6, complex: 8 });
  });

  it("forces compaction at turn budget", () => {
    const d = shouldCompact({ tier: "normal", turns: 4 });
    expect(d.compact).toBe(true);
    expect(d.byHardCeiling).toBe(false);
  });

  it("does not compact within budget", () => {
    const d = shouldCompact({ tier: "complex", turns: 3 });
    expect(d.compact).toBe(false);
  });

  it("hard ceiling via exact tokens triggers compaction", () => {
    const d = shouldCompact({
      tier: "normal",
      turns: 1,
      firstModelInputTokens: 950_000,
    });
    expect(d.compact).toBe(true);
    expect(d.byHardCeiling).toBe(true);
  });

  it("hard ceiling via chars fallback triggers compaction", () => {
    const ceiling = evaluateHardCeiling({ tier: "normal", promptChars: 1_500_000 });
    expect(ceiling.exceeds).toBe(true);
    expect(ceiling.measurementKind).toBe("chars");
  });

  it("unknown measurement does not falsely breach", () => {
    const ceiling = evaluateHardCeiling({ tier: "normal" });
    expect(ceiling.exceeds).toBe(false);
    expect(ceiling.measurementKind).toBe("unknown");
  });

  it("preserves essential state and stays bounded", () => {
    const huge = Array.from({ length: 1000 }, (_, i) => `file-${i}-`.padEnd(50, "x"));
    const serialized = preserveCompactState({
      objective: "implement KOMAA-184",
      decisions: huge,
      changedFiles: huge,
      tests: ["a.test.ts"],
      blockers: [],
      nextAction: "commit",
      runtimeIds: { runId: "r1", agentId: "a1", sessionId: "s1" },
    });
    expect(serialized.length).toBeLessThanOrEqual(COMPACT_STATE_MAX_CHARS);
    const parsed = JSON.parse(serialized) as { runtimeIds: { runId: string } };
    expect(parsed.runtimeIds.runId).toBe("r1");
  });

  it("large-history fixture triggers compaction before unbounded replay", () => {
    expect(detectLargeHistory({ sessionHistoryChars: 1_500_000 })).toBe(true);
    expect(detectLargeHistory({ replayCount: 5, maxReplay: 4 })).toBe(true);
    expect(detectLargeHistory({ sessionHistoryChars: 100, replayCount: 1 })).toBe(false);
  });
});
