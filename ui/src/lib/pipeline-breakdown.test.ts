import { describe, expect, it } from "vitest";
import {
  breakdownMechanicsBullets,
  breakdownSummarySentence,
  joinWithAnd,
  pieceNounPlural,
  readStageBreakdown,
  type BreakdownCopyNames,
  type StageBreakdownConfig,
} from "./pipeline-breakdown";

describe("readStageBreakdown", () => {
  it("returns null when there is no breakdown block", () => {
    expect(readStageBreakdown({ config: {} })).toBeNull();
    expect(readStageBreakdown({ config: null })).toBeNull();
    expect(readStageBreakdown(null)).toBeNull();
  });

  it("reads a full breakdown config and trims/defaults fields", () => {
    const config = readStageBreakdown({
      config: {
        breakdown: {
          targetPipelineId: " pipe-1 ",
          targetStageKey: " intake ",
          pieceNoun: " feature ",
          inheritFields: ["release", "", "  ", "owner"],
          advanceTo: "review",
          waitForPieces: true,
          whenFinishedMoveTo: "ship",
        },
      },
    });
    expect(config).toEqual({
      targetPipelineId: "pipe-1",
      targetStageKey: "intake",
      pieceNoun: "feature",
      inheritFields: ["release", "owner"],
      carryOverPolicy: {
        version: 1,
        mode: "only",
        includeFields: ["release", "owner"],
        excludeFields: [],
      },
      advanceTo: "review",
      waitForPieces: true,
      whenFinishedMoveTo: "ship",
    } satisfies StageBreakdownConfig);
  });

  it("reads versioned all-except carry-over policy", () => {
    const config = readStageBreakdown({
      config: {
        breakdown: {
          targetPipelineId: "pipe-1",
          targetStageKey: "intake",
          carryOverPolicy: { version: 1, mode: "all_except", excludeFields: ["owner"] },
        },
      },
    });
    expect(config?.carryOverPolicy).toEqual({
      version: 1,
      mode: "all_except",
      includeFields: [],
      excludeFields: ["owner"],
    });
  });

  it("defaults the noun to 'piece' when absent", () => {
    const config = readStageBreakdown({ config: { breakdown: { targetPipelineId: "p", targetStageKey: "s" } } });
    expect(config?.pieceNoun).toBe("piece");
    expect(config?.waitForPieces).toBe(false);
    expect(config?.carryOverPolicy).toEqual({
      version: 1,
      mode: "only",
      includeFields: [],
      excludeFields: [],
    });
  });
});

describe("pieceNounPlural", () => {
  it("appends s and falls back to piece", () => {
    expect(pieceNounPlural("feature")).toBe("features");
    expect(pieceNounPlural("  ")).toBe("pieces");
  });
});

describe("joinWithAnd", () => {
  it("joins with commas and a trailing and", () => {
    expect(joinWithAnd(["a"])).toBe("a");
    expect(joinWithAnd(["a", "b"])).toBe("a and b");
    expect(joinWithAnd(["a", "b", "c"])).toBe("a, b and c");
    expect(joinWithAnd([])).toBe("");
  });
});

const baseConfig: StageBreakdownConfig = {
  targetPipelineId: "pipe-1",
  targetStageKey: "intake",
  pieceNoun: "feature",
  inheritFields: ["release", "owner"],
  carryOverPolicy: {
    version: 1,
    mode: "only",
    includeFields: ["release", "owner"],
    excludeFields: [],
  },
  advanceTo: "review",
  waitForPieces: true,
  whenFinishedMoveTo: "ship",
};

const names: BreakdownCopyNames = {
  targetPipelineName: "Features",
  entryStageName: "Intake",
  advanceToName: "Review",
  whenFinishedName: "Ship",
  inheritedFieldLabels: ["Release", "Owner"],
};

describe("breakdownSummarySentence", () => {
  it("composes the full sentence including the wait clause", () => {
    expect(breakdownSummarySentence(baseConfig, names)).toBe(
      "Paperclip will create one feature per item in Features → Intake, carry over Release and Owner, move this case to Review, then wait until every feature is finished before moving it to Ship.",
    );
  });

  it("omits the wait clause when waiting is off", () => {
    const sentence = breakdownSummarySentence({ ...baseConfig, waitForPieces: false }, names);
    expect(sentence).toBe(
      "Paperclip will create one feature per item in Features → Intake, carry over Release and Owner, move this case to Review.",
    );
  });

  it("returns null when the target is not picked yet", () => {
    expect(breakdownSummarySentence({ ...baseConfig, targetPipelineId: "" }, names)).toBeNull();
    expect(breakdownSummarySentence(baseConfig, { ...names, targetPipelineName: "" })).toBeNull();
  });
});

describe("breakdownMechanicsBullets", () => {
  it("includes the empty-list bullet only when waiting is on", () => {
    const waiting = breakdownMechanicsBullets(baseConfig, names);
    expect(waiting.some((b) => b.includes("empty list"))).toBe(true);
    expect(waiting.some((b) => b.startsWith("Waits until every feature"))).toBe(true);

    const noWait = breakdownMechanicsBullets({ ...baseConfig, waitForPieces: false }, names);
    expect(noWait.some((b) => b.includes("empty list"))).toBe(false);
  });

  it("drops the carry-over bullet when there are no inherited fields", () => {
    const bullets = breakdownMechanicsBullets(
      { ...baseConfig, inheritFields: [] },
      { ...names, inheritedFieldLabels: [] },
    );
    expect(bullets.some((b) => b.startsWith("Carries over"))).toBe(false);
  });
});
