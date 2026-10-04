import { describe, expect, it } from "vitest";
import { __hasSatisfiedReviewVerdictForTests as hasSatisfiedReviewVerdict } from "../routes/issues.ts";

// listForIssue orders by createdAt ASC, then id ASC, so the array reads
// oldest first. The fixtures below follow that order.
const confirmation = (
  status: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  kind: "request_confirmation",
  status,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...extra,
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

  // A tool-action or secret-proposal confirmation is not a review decision.
  // The pending review check already excludes those payloads.
  it.each([
    ["toolAction", { toolAction: { name: "deploy" } }],
    ["secretProposal", { secretProposal: { name: "stripe" } }],
  ])(
    "rejects an accepted confirmation that carries a %s payload",
    (_label, payload) => {
      expect(
        hasSatisfiedReviewVerdict([
          confirmation("accepted", { payload }),
        ]),
      ).toBe(false);
    },
  );

  it("keeps a real verdict that carries an unrelated payload", () => {
    expect(
      hasSatisfiedReviewVerdict([
        confirmation("accepted", { payload: { summary: "looks good" } }),
      ]),
    ).toBe(true);
  });

  // An older acceptance must not survive a newer rejection. The later verdict
  // is the decision that still stands.
  it("rejects a superseded acceptance when a later verdict was rejected", () => {
    expect(
      hasSatisfiedReviewVerdict([
        confirmation("accepted", { createdAt: "2026-01-01T00:00:00.000Z" }),
        confirmation("rejected", { createdAt: "2026-02-01T00:00:00.000Z" }),
      ]),
    ).toBe(false);
  });

  it("rejects a superseded acceptance when a later verdict requested changes", () => {
    expect(
      hasSatisfiedReviewVerdict([
        confirmation("accepted", { createdAt: "2026-01-01T00:00:00.000Z" }),
        confirmation("revision_requested", {
          createdAt: "2026-02-01T00:00:00.000Z",
        }),
      ]),
    ).toBe(false);
  });

  it("accepts when a later verdict was accepted after an earlier rejection", () => {
    expect(
      hasSatisfiedReviewVerdict([
        confirmation("rejected", { createdAt: "2026-01-01T00:00:00.000Z" }),
        confirmation("accepted", { createdAt: "2026-02-01T00:00:00.000Z" }),
      ]),
    ).toBe(true);
  });

  it("ignores a newer rejection when the newer row is not a review verdict", () => {
    expect(
      hasSatisfiedReviewVerdict([
        confirmation("accepted", { createdAt: "2026-01-01T00:00:00.000Z" }),
        {
          kind: "ask_user_questions",
          status: "rejected",
          createdAt: "2026-02-01T00:00:00.000Z",
        },
      ]),
    ).toBe(true);
  });
});
