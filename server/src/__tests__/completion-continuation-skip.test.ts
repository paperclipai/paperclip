import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  readStatedDispositionStatus,
  statedDispositionBlocksContinuation,
} from "../services/heartbeat.js";

// TSMC-21480 (parent TSMC-21371). `completion_continuation` re-offered the same
// card to the same agent immediately after a productive run. Two states make
// that offer pure burn and neither was checked — the only gate was TSMC-21372's
// chain cap, which bounds the loop at 3 but does not stop it starting.

describe("a stated disposition blocks continuation (TSMC-21480)", () => {
  it.each(["done", "cancelled", "in_review", "blocked"])(
    "does not continue after the agent stated %s",
    (status) => {
      expect(statedDispositionBlocksContinuation({ disposition: { status } })).toBe(true);
    },
  );

  it("continues when the agent stated an in-flight status", () => {
    expect(statedDispositionBlocksContinuation({ disposition: { status: "in_progress" } })).toBe(false);
    expect(statedDispositionBlocksContinuation({ disposition: { status: "todo" } })).toBe(false);
  });

  it("continues when no disposition was stated at all", () => {
    // The common case: a productive run that simply did not state anything.
    expect(statedDispositionBlocksContinuation(null)).toBe(false);
    expect(statedDispositionBlocksContinuation({})).toBe(false);
    expect(statedDispositionBlocksContinuation({ disposition: null })).toBe(false);
  });

  it("treats a malformed or blank disposition as no statement, never as a block", () => {
    // Failing OPEN here matters: a parse quirk must not silently stop all
    // continuation for a lane, which would look identical to "no work left".
    expect(readStatedDispositionStatus({ disposition: { status: "   " } })).toBeNull();
    expect(readStatedDispositionStatus({ disposition: { status: 42 } })).toBeNull();
    expect(readStatedDispositionStatus("not an object")).toBeNull();
    expect(statedDispositionBlocksContinuation({ disposition: { status: 42 } })).toBe(false);
  });

  it("trims a padded status so ' done ' still blocks", () => {
    expect(readStatedDispositionStatus({ disposition: { status: " done " } })).toBe("done");
    expect(statedDispositionBlocksContinuation({ disposition: { status: " done " } })).toBe(true);
  });
});

describe("the continuation site is wired to both guards (TSMC-21480)", () => {
  // Wiring assertions, labelled as such: the tests above prove the decision
  // logic, but cannot prove the wake site consults it. TSKB0055 K45 is why this
  // is stated plainly rather than dressed up as behaviour.
  const src = readFileSync(
    fileURLToPath(new URL("../services/heartbeat.ts", import.meta.url)),
    "utf8",
  );
  const site = src.slice(
    src.indexOf("const lastRun = await db"),
    src.indexOf('triggerDetail: "completion_continuation"'),
  );

  it("checks the stated disposition before offering a continuation", () => {
    expect(site).toContain("statedDispositionBlocksContinuation(lastRun.resultJson)");
  });

  it("checks for a pending operator ask on the same issue", () => {
    expect(site).toContain("OPERATOR_ASK_INTERACTION_KINDS");
    expect(site).toContain('eq(issueThreadInteractions.status, "pending")');
  });

  it("puts the offer on the else branch, so a guarded card is not offered", () => {
    expect(site).toContain("if (stillOpen && (statedNoContinue || pendingOperatorAsk)) {");
    expect(site).toContain("} else if (stillOpen) {");
  });

  it("still carries the TSMC-21372 chain cap it must not replace", () => {
    expect(src).toContain("MAX_COMPLETION_CONTINUATION_CHAIN");
  });
});
