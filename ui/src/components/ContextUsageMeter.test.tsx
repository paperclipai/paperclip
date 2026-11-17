import { describe, expect, it } from "vitest";
import { contextUsageLevel, formatContextTokens } from "./ContextUsageMeter";

describe("contextUsageLevel", () => {
  it("is neutral well below compaction", () => {
    expect(contextUsageLevel({ usedTokens: 100_000, contextWindow: 272_000, autoCompactTokens: 244_800 })).toBe("normal");
  });
  it("turns amber within ten points of auto-compaction", () => {
    expect(contextUsageLevel({ usedTokens: 229_500, contextWindow: 272_000, autoCompactTokens: 244_800 })).toBe("near");
    expect(contextUsageLevel({ usedTokens: 170_000, contextWindow: 200_000 })).toBe("near");
  });
  it("turns red at 95%", () => {
    expect(contextUsageLevel({ usedTokens: 191_300, contextWindow: 200_000 })).toBe("full");
  });
});

describe("formatContextTokens", () => {
  it("abbreviates token counts", () => {
    expect(formatContextTokens(950)).toBe("950");
    expect(formatContextTokens(1_240)).toBe("1.2k");
    expect(formatContextTokens(258_400)).toBe("258k");
    expect(formatContextTokens(1_000_000)).toBe("1M");
  });
});
