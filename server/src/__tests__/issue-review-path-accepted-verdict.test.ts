import { describe, expect, it } from "vitest";
import { __hasSatisfiedReviewVerdictForTests as hasSatisfiedReviewVerdict } from "../routes/issues.ts";

const confirmation = (status: string) => ({
  kind: "request_confirmation",
  status,
});

// An issue parked on `blocked` after an accepted review cannot be returned to
// `in_review` on the agent-authored path, because assertInReviewReviewPath
// only counted a *pending* review interaction. A recorded, accepted verdict is
// auditable evidence that the judgement already happened.
describe("recorded review verdicts as a satisfied in_review review path", () => {
  it("accepts an accepted request_confirmation verdict", () => {
    expect(hasSatisfiedReviewVerdict([confirmation("accepted")])).toBe(true);
  });

  it("accepts an accepted request_checkbox_confirmation verdict", () => {
    expect(
      hasSatisfiedReviewVerdict([
        { kind: "request_checkbox_confirmation", status: "accepted" },
      ]),
    ).toBe(true);
  });

  // Mandatory negative control. A guard only ever seen passing has not been
  // tested: every non-accepted verdict must keep failing closed.
  it.each([
    "revision_requested",
    "request_changes",
    "rejected",
    "send_back",
    "expired",
    "pending",
  ])("rejects a %s verdict", (status) => {
    expect(hasSatisfiedReviewVerdict([confirmation(status)])).toBe(false);
  });

  it("ignores non-review interaction kinds", () => {
    expect(
      hasSatisfiedReviewVerdict([
        { kind: "ask_user_questions", status: "accepted" },
      ]),
    ).toBe(false);
  });

  it("returns false when no verdict is recorded", () => {
    expect(hasSatisfiedReviewVerdict([])).toBe(false);
  });

  it("is satisfied by an accepted verdict alongside unrelated interactions", () => {
    expect(
      hasSatisfiedReviewVerdict([
        { kind: "ask_user_questions", status: "expired" },
        confirmation("accepted"),
      ]),
    ).toBe(true);
  });
});
