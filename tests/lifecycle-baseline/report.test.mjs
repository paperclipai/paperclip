import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize } from "./report.mjs";
import { lanes, scenarios } from "./inventory.mjs";
import { existsSync } from "node:fs";
test("inventory references executable files and unique scenario IDs", () => {
  assert.equal(new Set(scenarios.map((s) => s.id)).size, scenarios.length);
  for (const s of scenarios)
    for (const r of s.coverage) {
      assert.ok(lanes[r.lane].files.includes(r.file));
      assert.ok(existsSync(r.file), r.file);
    }
});
test("absent lane is unmeasured; absent evidence in an executed lane fails closed", () => {
  assert.equal(
    summarize({})[0].coverage.find((c) => c.lane === "unit").status,
    "not_run",
  );
  assert.equal(
    summarize({ unit: { testResults: [] } })[0].coverage.find(
      (c) => c.lane === "unit",
    ).status,
    "harness_evidence_failure",
  );
});
test("pass, assertion failure and skip remain distinct", () => {
  for (const [status, expected] of [
    ["passed", "pass"],
    ["failed", "assertion_failure"],
    ["pending", "unavailable_prerequisite"],
  ]) {
    const rows = summarize({
      unit: {
        testResults: [
          {
            name: "/repo/tests/lifecycle-baseline/authority.test.ts",
            status: "passed",
            assertionResults: [{ fullName: "LCA-01 complete", status }],
          },
        ],
      },
    });
    assert.equal(
      rows[0].coverage.find((c) => c.lane === "unit").status,
      expected,
    );
  }
});

test("an unrelated failed assertion does not erase a passing scenario in the same file", () => {
  const rows = summarize({
    unit: {
      testResults: [
        {
          name: "/repo/tests/lifecycle-baseline/authority.test.ts",
          status: "failed",
          assertionResults: [
            { fullName: "LCA-01 complete", status: "passed" },
            { fullName: "LCA-02 wording", status: "failed" },
          ],
        },
      ],
    },
  });
  assert.equal(rows[0].coverage.find((c) => c.lane === "unit").status, "pass");
  assert.equal(
    rows[1].coverage.find((c) => c.lane === "unit").status,
    "assertion_failure",
  );
});
