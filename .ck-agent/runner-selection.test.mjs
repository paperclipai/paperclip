import test from "node:test";
import assert from "node:assert/strict";
import {
  checkoutExpectedStatuses,
  pickWorkableIssue,
} from "./runner-selection.mjs";

test("selects the most recently updated workable issue", () => {
  assert.equal(
    pickWorkableIssue([
      { id: "old", status: "todo", updatedAt: "2026-01-01" },
      { id: "new", status: "in_progress", updatedAt: "2026-01-02" },
    ])?.id,
    "new",
  );
});

test("does not select arbitrary blocked or review-waiting issues", () => {
  assert.equal(
    pickWorkableIssue([
      { id: "blocked", status: "blocked" },
      { id: "review", status: "in_review" },
      { id: "done", status: "done" },
    ]),
    null,
  );
});

test("a targeted comment or Hold wake can resume its in-review issue", () => {
  assert.equal(
    pickWorkableIssue(
      [
        { id: "other", status: "todo", updatedAt: "2026-01-02" },
        { id: "feedback-target", status: "in_review", updatedAt: "2026-01-01" },
      ],
      "feedback-target",
    )?.id,
    "feedback-target",
  );
});

test("a targeted blocked issue remains non-workable", () => {
  assert.equal(
    pickWorkableIssue([{ id: "blocked", status: "blocked" }], "blocked"),
    null,
  );
});

test("checkout permits in-review only for its targeted feedback wake", () => {
  assert.deepEqual(
    checkoutExpectedStatuses({ id: "feedback-target", status: "in_review" }, "feedback-target"),
    ["todo", "in_progress", "in_review"],
  );
  assert.deepEqual(
    checkoutExpectedStatuses({ id: "other", status: "in_review" }, "feedback-target"),
    ["todo", "in_progress"],
  );
});
