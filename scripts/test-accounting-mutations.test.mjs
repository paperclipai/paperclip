import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

for (const scenario of ["success", "baseline", "survives", "missing", "database", "timeout", "wrong_assertion", "wrong_sentinel", "missing_marker", "extra_failure", "skipped"]) {
  test(`mutation gate retains evidence: ${scenario}`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mutation-evidence-test-"));
    try {
      await mkdir(path.join(root, "scripts"));
      await mkdir(path.join(root, "node_modules/vitest"), { recursive: true });
      await copyFile(path.resolve("scripts/test-accounting-mutations.mjs"), path.join(root, "scripts/test-accounting-mutations.mjs"));
      await writeFile(path.join(root, "node_modules/vitest/vitest.mjs"), `
import { writeFileSync } from 'node:fs';
const name = process.env.PAPERCLIP_ACCOUNTING_MUTATION;
const scenario = process.env.MUTATION_EVIDENCE_TEST_SCENARIO;
const titles = { deduplication: 'deduplicates a retried receipt', company: 'isolates company reporting', projection: 'conserves agent projections', threshold: 'stops at the exact budget boundary' };
console.log(name && scenario !== 'missing_marker' ? 'ACCOUNTING_MUTATION_APPLIED ' + name : 'baseline diagnostics');
if (name && scenario === 'missing') process.exit(1);
const fail = name ? scenario !== 'survives' : scenario === 'baseline';
const failureMessage = scenario === 'database' ? 'Error: connection refused'
  : scenario === 'timeout' ? 'Error: Test timed out in 10000ms'
  : scenario === 'wrong_assertion' ? 'AssertionError: expected 1 to be 2'
  : 'AssertionError: ACCOUNTING_ASSERTION ' + name + ': expected value to match';
const assertionResults = Object.values(titles).map(title => {
  const failed = fail && (!name || title === titles[scenario === 'wrong_sentinel' ? 'company' : name] || scenario === 'extra_failure');
  return { title, status: failed ? 'failed' : name && scenario === 'skipped' ? 'pending' : 'passed', failureMessages: failed ? [failureMessage] : [] };
});
writeFileSync(process.argv.find(arg => arg.startsWith('--outputFile=')).slice(13), JSON.stringify({ testResults: [{ assertionResults }] }));
process.exit(fail ? 1 : 0);
`);
      if (scenario === "missing") {
        await mkdir(path.join(root, "coverage/accounting/mutations"), { recursive: true });
        await writeFile(path.join(root, "coverage/accounting/mutations/deduplication.json"), '{"stale":true}');
      }
      const result = spawnSync(process.execPath, ["scripts/test-accounting-mutations.mjs"], { cwd: root,
        env: { ...process.env, MUTATION_EVIDENCE_TEST_SCENARIO: scenario }, encoding: "utf8" });
      assert.equal(result.status, scenario === "success" ? 0 : 1, result.stderr);
      const report = JSON.parse(await readFile(path.join(root, "coverage/accounting/mutations.json"), "utf8"));
      assert.equal(report.evidence.at(-1).result, { success: "killed", baseline: "baseline_failed", missing: "error" }[scenario] ?? "survived_or_invalid");
      const last = report.evidence.at(-1).mutation;
      assert.ok((await readFile(path.join(root, `coverage/accounting/mutations/${last}.log`), "utf8")).length);
      if (scenario === "missing") await assert.rejects(access(path.join(root, `coverage/accounting/mutations/${last}.json`)));
      if (scenario !== "missing") assert.ok(JSON.parse(await readFile(path.join(root, `coverage/accounting/mutations/${last}.json`), "utf8")).testResults.length);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
