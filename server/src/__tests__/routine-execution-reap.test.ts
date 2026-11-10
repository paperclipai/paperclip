import { describe, expect, it } from "vitest";
import {
  buildRoutineExecutionCorpseReapComment,
  isStaleAcrossConsecutiveTicks,
  isUnexplainedBlockedIssue,
  ROUTINE_CORPSE_REAP_MIN_CONSECUTIVE_TICKS,
} from "../services/routine-execution-reap.ts";

describe("isUnexplainedBlockedIssue", () => {
  it("is false for a non-blocked issue regardless of descriptor", () => {
    expect(isUnexplainedBlockedIssue({ status: "todo", unblockDescriptor: null })).toBe(false);
    expect(isUnexplainedBlockedIssue({ status: "in_progress", unblockDescriptor: null })).toBe(false);
  });

  it("is false for a blocked issue carrying an unblockDescriptor", () => {
    expect(
      isUnexplainedBlockedIssue({
        status: "blocked",
        unblockDescriptor: { owner: "board", action: "do something" },
      }),
    ).toBe(false);
  });

  it("is true for a blocked issue with no unblockDescriptor at all", () => {
    expect(isUnexplainedBlockedIssue({ status: "blocked", unblockDescriptor: null })).toBe(true);
    expect(isUnexplainedBlockedIssue({ status: "blocked", unblockDescriptor: undefined })).toBe(true);
  });
});

describe("isStaleAcrossConsecutiveTicks", () => {
  const candidateId = "issue-1";

  it("is false when fewer ticks exist than the threshold", () => {
    expect(isStaleAcrossConsecutiveTicks([candidateId, candidateId], candidateId, 3)).toBe(false);
  });

  it("is false when an earlier tick exists with no threshold ticks at all", () => {
    expect(isStaleAcrossConsecutiveTicks([], candidateId, 3)).toBe(false);
  });

  it("is true when the last N ticks all resolved to the same candidate", () => {
    expect(
      isStaleAcrossConsecutiveTicks([candidateId, candidateId, candidateId], candidateId, 3),
    ).toBe(true);
  });

  it("is true when there are more than N matching ticks", () => {
    expect(
      isStaleAcrossConsecutiveTicks(
        [candidateId, candidateId, candidateId, candidateId, "issue-0"],
        candidateId,
        3,
      ),
    ).toBe(true);
  });

  it("is false when any of the last N ticks points somewhere else", () => {
    expect(
      isStaleAcrossConsecutiveTicks([candidateId, "issue-2", candidateId], candidateId, 3),
    ).toBe(false);
  });

  it("is false when a tick resolved to nothing at all (e.g. a fresh create)", () => {
    expect(isStaleAcrossConsecutiveTicks([candidateId, candidateId, null], candidateId, 3)).toBe(false);
  });

  it("defaults the threshold to ROUTINE_CORPSE_REAP_MIN_CONSECUTIVE_TICKS", () => {
    const ticks = Array.from({ length: ROUTINE_CORPSE_REAP_MIN_CONSECUTIVE_TICKS }, () => candidateId);
    expect(isStaleAcrossConsecutiveTicks(ticks, candidateId)).toBe(true);
    expect(isStaleAcrossConsecutiveTicks(ticks.slice(1), candidateId)).toBe(false);
  });
});

describe("buildRoutineExecutionCorpseReapComment", () => {
  it("names the threshold and both tickets it reconciles", () => {
    const body = buildRoutineExecutionCorpseReapComment({ minConsecutiveTicks: 3 });
    expect(body).toContain("3 firings");
    expect(body).toContain("CRE-4176");
    expect(body).toContain("CRE-4157");
  });
});
