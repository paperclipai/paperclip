import { describe, expect, it } from "vitest";
import { deriveMeetingCriteria } from "./grader.js";
import { idsBillingType } from "./ids.js";
import type { IssueCandidate } from "./segments.js";

describe("Weekly Tactical lifecycle", () => {
  it("treats a meeting with no promoted issue as complete without inventing a decision", () => {
    expect(
      deriveMeetingCriteria(
        [],
        { solved: [], goldenCasesWritten: 0, observedCents: 0 },
        5,
      ),
    ).toEqual({
      decisions_with_owner_due: true,
      solved_top_constraint_issue: true,
      wrote_golden_case: true,
      stayed_in_budget: true,
    });
  });

  it("still requires an owner, due date, and golden case when an issue is promoted", () => {
    const promoted: IssueCandidate[] = [{
      sourceKind: "scorecard_spc",
      sourceRef: "spec-1",
      title: "Revenue signal",
      impactScore: 3,
      believability: 1,
      evidence: {},
    }];
    expect(
      deriveMeetingCriteria(
        promoted,
        { solved: [], goldenCasesWritten: 0, observedCents: 0 },
        5,
      ),
    ).toMatchObject({
      decisions_with_owner_due: false,
      solved_top_constraint_issue: false,
      wrote_golden_case: false,
      stayed_in_budget: true,
    });
  });

  it("records DeepSeek IDS calls as metered without classifying stubs as spend", () => {
    expect(idsBillingType("deepseek")).toBe("metered_api");
    expect(idsBillingType("stub")).toBe("unknown");
  });
});
