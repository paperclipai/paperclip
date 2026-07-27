import { describe, expect, it } from "vitest";
import { extractAcceptanceCriteriaFromFeatureSpec, parseJudgeResult } from "./evaluate.js";
import { buildReflectionCommentBody } from "./reflection.js";
import { resolveEvaluationTrigger } from "./types.js";

describe("agent manager evaluate helpers", () => {
  it("parses valid judge JSON", () => {
    const result = parseJudgeResult({
      score: 62,
      rationale: "Missing tests",
      criteriaResults: [{ id: "AC-1", met: false, note: "no tests" }],
      corrections: [{ priority: "must", instruction: "Add unit tests" }],
      hardFailure: false,
    });
    expect(result?.score).toBe(62);
  });

  it("rejects invalid judge JSON", () => {
    expect(parseJudgeResult({ score: 200 })).toBeNull();
  });

  it("extracts acceptance criteria from feature spec JSON", () => {
    const body = JSON.stringify({
      acceptanceCriteria: [{
        id: "AC-1",
        given: "a run completes",
        when: "evaluated",
        then: "score is produced",
      }],
    });
    expect(extractAcceptanceCriteriaFromFeatureSpec(body)).toEqual([{
      id: "AC-1",
      description: "a run completes evaluated score is produced",
    }]);
  });
});

describe("resolveEvaluationTrigger", () => {
  it("maps succeeded status", () => {
    expect(resolveEvaluationTrigger({ status: "succeeded", livenessState: null })).toBe("run_succeeded");
  });

  it("maps needs_followup liveness", () => {
    expect(resolveEvaluationTrigger({ status: "succeeded", livenessState: "needs_followup" })).toBe("needs_followup");
  });

  it("skips cancelled runs", () => {
    expect(resolveEvaluationTrigger({ status: "cancelled", livenessState: null })).toBeNull();
  });
});

describe("reflection comment builder", () => {
  it("includes score and corrections", () => {
    const body = buildReflectionCommentBody({
      score: 55,
      threshold: 70,
      attempt: 1,
      maxAttempts: 3,
      rationale: "Off spec",
      corrections: [{ priority: "must", instruction: "Fix API contract" }],
      criteriaResults: [{ id: "AC-1", met: false, note: "missing" }],
    });
    expect(body).toContain("55/100");
    expect(body).toContain("Fix API contract");
  });
});
