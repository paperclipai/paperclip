import { describe, expect, it } from "vitest";
import {
  buildDecidedReviewContinuationWakeup,
  classifyDecidedReviewWake,
  decideDecidedReviewAdmission,
  type DecidedReviewAdmissionReads,
  type DecidedReviewWake,
} from "./decided-review-reassignment.js";

const reviewer = "agent-reviewer";
const identity = { decisionId: "decision-1", resubmissionActivityId: "activity-1" };
const record = {
  sourceRunId: "run-r", ...identity, chainRunIds: [], successorRunId: "run-s",
  shape: "in_review" as const, recordedAt: "2026-01-01T00:00:00.000Z",
};

function recoveryWake(carried: Record<string, unknown> = { sourceRunId: "run-r", ...identity }): DecidedReviewWake {
  const wake = buildDecidedReviewContinuationWakeup({ issueId: "issue-1", sourceRunId: "run-r", ...identity });
  return {
    agentId: reviewer, reason: wake.reason, source: wake.source, requestedByActorType: wake.requestedByActorType,
    payload: { ...wake.payload, decidedReviewContinuation: carried }, carriesInput: false,
  };
}

function reviewRequest(overrides: Partial<DecidedReviewWake> = {}): DecidedReviewWake {
  return {
    agentId: reviewer, reason: "execution_review_requested", source: "assignment", requestedByActorType: "agent",
    payload: { issueId: "issue-1" }, carriesInput: false, ...overrides,
  };
}

/** In-memory reads. Every read not configured for a case throws, so a test
 * fails if the admission order consults something it must not. */
function reads(overrides: Partial<DecidedReviewAdmissionReads>): DecidedReviewAdmissionReads {
  const unexpected = (name: string) => async () => { throw new Error(`unexpected read: ${name}`); };
  return {
    identity: unexpected("identity"),
    consumption: unexpected("consumption"),
    successorActive: unexpected("successorActive"),
    select: unexpected("select"),
    hasBlocker: unexpected("hasBlocker"),
    prove: unexpected("prove"),
    ...overrides,
  };
}

describe("classifyDecidedReviewWake", () => {
  it("recognises the pass's continuation wake as W1", () => {
    expect(classifyDecidedReviewWake(recoveryWake(), reviewer)).toBe("W1");
  });

  it("recognises the author's same-submission review request as W2", () => {
    expect(classifyDecidedReviewWake(reviewRequest(), reviewer)).toBe("W2");
    expect(classifyDecidedReviewWake(reviewRequest({ requestedByActorType: "system", source: "automation" }), reviewer)).toBe("W2");
  });

  it.each([
    ["a comment, saved input, interaction or failed-run retry", reviewRequest({ carriesInput: true })],
    ["a user requester", reviewRequest({ requestedByActorType: "user" })],
    ["another reason", reviewRequest({ reason: "issue_commented" })],
    ["a wake for a different agent", reviewRequest({ agentId: "agent-other" })],
  ])("leaves %s as W3", (_label, wake) => {
    expect(classifyDecidedReviewWake(wake, reviewer)).toBe("W3");
  });

  it("does not treat a continuation payload from a non-system requester as W1", () => {
    expect(classifyDecidedReviewWake({ ...recoveryWake(), requestedByActorType: "agent" }, reviewer)).toBe("W3");
  });
});

describe("decideDecidedReviewAdmission", () => {
  it("returns continue for W3 without reading anything", async () => {
    await expect(decideDecidedReviewAdmission("W3", reviewRequest(), reads({}))).resolves.toEqual({ kind: "continue" });
  });

  describe("step 2: identity", () => {
    it("skips W1 as stale when no current identity exists, and lets W2 continue", async () => {
      const r = reads({ identity: async () => null });
      await expect(decideDecidedReviewAdmission("W1", recoveryWake(), r)).resolves.toEqual({
        kind: "skip", reason: "decided_review_continuation_stale", detail: { detail: "identity_unavailable" },
      });
      await expect(decideDecidedReviewAdmission("W2", reviewRequest(), r)).resolves.toEqual({ kind: "continue" });
    });

    it.each([
      ["a newer decision", { decisionId: "decision-2", resubmissionActivityId: "activity-1" }],
      ["a newer submission", { decisionId: "decision-1", resubmissionActivityId: "activity-2" }],
    ])("skips W1 as stale after %s", async (_label, current) => {
      const result = await decideDecidedReviewAdmission("W1", recoveryWake(), reads({ identity: async () => current }));
      expect(result).toMatchObject({ kind: "skip", reason: "decided_review_continuation_stale", detail: { detail: "identity_changed" } });
    });
  });

  describe("step 3: consumption runs before source selection", () => {
    it.each(["W1", "W2"] as const)("coalesces %s into a successor that still owns the execution", async (wakeClass) => {
      const result = await decideDecidedReviewAdmission(wakeClass, wakeClass === "W1" ? recoveryWake() : reviewRequest(), reads({
        identity: async () => identity, consumption: async () => record, successorActive: async () => true,
      }));
      expect(result).toEqual({ kind: "coalesce", runId: "run-s" });
    });

    it.each(["W1", "W2"] as const)("records %s as consumed once the successor has ended", async (wakeClass) => {
      const result = await decideDecidedReviewAdmission(wakeClass, wakeClass === "W1" ? recoveryWake() : reviewRequest(), reads({
        identity: async () => identity, consumption: async () => record, successorActive: async () => false,
      }));
      expect(result).toEqual({
        kind: "skip", reason: "decided_review_continuation_consumed", detail: { successorRunId: "run-s", ...identity },
      });
    });
  });

  describe("step 4: source selection for an unconsumed identity", () => {
    const unselected = { identity: async () => identity, consumption: async () => null,
      select: async () => ({ kind: "none" as const, rule: "newer_run_not_verified_pre_dispatch_wait", runId: "run-u" }) };

    it("skips W1 as not eligible, naming the failing rule", async () => {
      await expect(decideDecidedReviewAdmission("W1", recoveryWake(), reads(unselected))).resolves.toEqual({
        kind: "skip", reason: "decided_review_continuation_not_eligible",
        detail: { rule: "newer_run_not_verified_pre_dispatch_wait", runId: "run-u", ...identity },
      });
    });

    it("lets W2 continue on the baseline path", async () => {
      await expect(decideDecidedReviewAdmission("W2", reviewRequest(), reads(unselected))).resolves.toEqual({ kind: "continue" });
    });
  });

  describe("step 5: proof and admission", () => {
    const selected = { identity: async () => identity, consumption: async () => null, select: async () => ({ kind: "selected" as const }) };

    it("skips W1 as not held, and lets W2 take the ordinary path, when no blocker exists", async () => {
      const r = reads({ ...selected, hasBlocker: async () => false });
      await expect(decideDecidedReviewAdmission("W1", recoveryWake(), r)).resolves.toEqual({
        kind: "skip", reason: "decided_review_continuation_not_held", detail: { ...identity },
      });
      await expect(decideDecidedReviewAdmission("W2", reviewRequest(), r)).resolves.toEqual({ kind: "continue" });
    });

    it("skips W1 as unproven with the failing predicate, and lets W2 defer on the baseline path", async () => {
      const r = reads({ ...selected, hasBlocker: async () => true, prove: async () => ({ kind: "hold" as const, reason: "P2_lease_unreleased" }) });
      await expect(decideDecidedReviewAdmission("W1", recoveryWake(), r)).resolves.toEqual({
        kind: "skip", reason: "decided_review_continuation_unproven", detail: { predicate: "P2_lease_unreleased", ...identity },
      });
      await expect(decideDecidedReviewAdmission("W2", reviewRequest(), r)).resolves.toEqual({ kind: "continue" });
    });

    it.each(["W1", "W2"] as const)("admits %s when a blocker exists and the proof holds", async (wakeClass) => {
      const r = reads({ ...selected, hasBlocker: async () => true, prove: async () => ({ kind: "proved" as const }) });
      await expect(decideDecidedReviewAdmission(wakeClass, wakeClass === "W1" ? recoveryWake() : reviewRequest(), r))
        .resolves.toEqual({ kind: "admit", identity });
    });
  });
});
