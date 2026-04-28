import { describe, expect, it } from "vitest";
import {
  areContinuationLoopGuardCommentsSimilar,
  CONTINUATION_LOOP_GUARD_SIMILARITY_THRESHOLD,
  cosineSimilarity,
  normalizeContinuationLoopGuardComment,
} from "../services/continuation-loop-guard.js";

describe("continuation-loop-guard similarity", () => {
  it("treats identical normalized bodies as similar", () => {
    const a = "## Heartbeat\n\nRun abc-123 succeeded.";
    const b = "## Heartbeat\n\nRun xyz-789 succeeded.";
    expect(normalizeContinuationLoopGuardComment(a)).toBe(normalizeContinuationLoopGuardComment(b));
    expect(areContinuationLoopGuardCommentsSimilar(a, b)).toBe(true);
  });

  it("scores high cosine similarity on paraphrases", () => {
    const a = "waiting on external reviewer feedback before merging";
    const b = "still waiting on external reviewer feedback prior to merging";
    expect(
      cosineSimilarity(normalizeContinuationLoopGuardComment(a), normalizeContinuationLoopGuardComment(b)),
    ).toBeGreaterThanOrEqual(CONTINUATION_LOOP_GUARD_SIMILARITY_THRESHOLD);
    expect(areContinuationLoopGuardCommentsSimilar(a, b)).toBe(true);
  });

  it("does not classify substantially different updates as similar", () => {
    const a = "blocked: need prod credentials";
    const b = "implemented feature and opened pull request";
    expect(areContinuationLoopGuardCommentsSimilar(a, b)).toBe(false);
  });
});
