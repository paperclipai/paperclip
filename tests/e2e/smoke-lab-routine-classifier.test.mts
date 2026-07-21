import test from "node:test";
import assert from "node:assert/strict";

import {
  findDuplicateFailureIssue,
  isForcedFailureSelfTest,
} from "./smoke-lab-routine.mts";

test("recognizes the single synthetic forced-failure step only when the drill env is set", () => {
  const failed = ["P3/forced-failure: SMOKE_FORCE_FAIL: induced failure (v2)"];

  assert.equal(isForcedFailureSelfTest(failed, "induced failure (v2)"), true);
  assert.equal(isForcedFailureSelfTest(failed, ""), false);
});

test("does not classify mixed real failures as the forced-failure self-test", () => {
  assert.equal(
    isForcedFailureSelfTest(
      [
        "P3/allowed-read: ASSERT FAILED: audit row for time.now",
        "P3/forced-failure: SMOKE_FORCE_FAIL: induced failure",
      ],
      "induced failure",
    ),
    false,
  );
});

test("finds an existing non-cancelled failure issue for the same routine", () => {
  const title = "Smoke Lab failure: P3 / forced-failure";
  const routineIssueId = "routine-issue";

  assert.equal(
    findDuplicateFailureIssue(
      [
        { id: "cancelled", parentId: routineIssueId, status: "cancelled", title },
        { id: "other-parent", parentId: "other", status: "done", title },
        { id: "existing", parentId: routineIssueId, status: "done", title },
      ],
      title,
      routineIssueId,
    )?.id,
    "existing",
  );
});
