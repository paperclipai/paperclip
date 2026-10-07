import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function reports() {
  return [
    { success: true, testResults: [{ name: "/repo/server/src/__tests__/cost-accounting-crash.test.ts", assertionResults:
      ["before_receipt", "before_runtime_totals", "before_commit", "after_commit_before_delivery_ack"].map(phase => ({
        fullName: `accounting survives real server SIGKILL recovers exactly once after ${phase}`, status: "passed",
      })),
    }] },
    { success: true, testResults: [{ name: "/repo/packages/db/src/cost-accounting-migration.test.ts", assertionResults:
      ["preserves historical receipts, counters, references, finance currencies and incident history",
        "rejects invalid historical amounts atomically and can retry after explicit repair"].map(title => ({
        fullName: `cost accounting historical upgrade ${title}`, status: "passed",
      })),
    }] },
  ];
}

for (const scenario of ["passed", "skipped_crash", "skipped_migration", "missing_case", "missing_suite", "duplicate_case", "duplicate_suite", "wrong_suite", "failed", "malformed", "missing_report"]) {
  test(`required accounting evidence: ${scenario}`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "accounting-required-tests-"));
    try {
      const data = reports();
      const crash = data[0].testResults[0];
      const migration = data[1].testResults[0];
      if (scenario === "skipped_crash") crash.assertionResults[0].status = "pending";
      if (scenario === "skipped_migration") migration.assertionResults[1].status = "pending";
      if (scenario === "missing_case") crash.assertionResults.pop();
      if (scenario === "missing_suite") data[1].testResults = [];
      if (scenario === "duplicate_case") migration.assertionResults.push(migration.assertionResults[0]);
      if (scenario === "duplicate_suite") data[0].testResults.push(crash);
      if (scenario === "wrong_suite") crash.assertionResults[0].fullName = "another test with the same title";
      if (scenario === "failed") data[0].success = false;
      const files = data.map((_, index) => path.join(directory, `${index}.json`));
      for (const [index, report] of data.entries()) {
        if (scenario === "missing_report" && index === 1) continue;
        await writeFile(files[index], scenario === "malformed" ? "{" : JSON.stringify(report));
      }
      const result = spawnSync(process.execPath, ["scripts/verify-accounting-test-results.mjs", ...files], { encoding: "utf8" });
      assert.equal(result.status, scenario === "passed" ? 0 : 1, result.stderr);
      if (scenario === "passed") assert.match(result.stdout, /Verified 4 required tests:[\s\S]*Verified 2 required tests:/);
      else assert.match(result.stderr, /Accounting gate:/);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
