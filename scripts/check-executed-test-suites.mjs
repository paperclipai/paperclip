#!/usr/bin/env node
/**
 * RBR-918 AC3: a suite that reports zero executed tests must not be able to
 * report success.
 *
 * The dangerous shape is a test file whose tests all report `skipped` while the
 * run still exits 0. Two mechanisms produce it:
 *
 *  1. A `beforeAll` that boots embedded Postgres inside a budget it cannot meet.
 *     On vitest 4 this surfaces as a failed suite (exit 1), so it is loud — but
 *     only because vitest changed; on older majors it was silent.
 *  2. `describeEmbeddedPostgres = supported ? describe : describe.skip`. When the
 *     support probe fails, the whole file skips and the run exits 0. Verified:
 *     a file gated this way reports `success: true` with every test `skipped`.
 *
 * Mechanism 2 is why "the rest of the suite is green" was accepted as evidence
 * on RBR-875 while the suite had not executed. This guard closes it: any file
 * that executed zero of its tests fails the run.
 *
 * Escape hatch for developer hosts that genuinely cannot run embedded Postgres:
 * set PAPERCLIP_ALLOW_ZERO_EXECUTED_SUITES=1. CI must not set it.
 *
 * Usage: node scripts/check-executed-test-suites.mjs <vitest-json-report>
 */
import { readFileSync } from "node:fs";

const EXECUTED_STATUSES = new Set(["passed", "failed"]);

/**
 * Returns the files that executed none of their tests.
 * @param {{ testResults?: Array<{ name: string, assertionResults?: Array<{ status: string }> }> }} report
 */
export function findZeroExecutedSuites(report) {
  const suites = Array.isArray(report?.testResults) ? report.testResults : [];
  const offenders = [];
  for (const suite of suites) {
    const assertions = Array.isArray(suite.assertionResults) ? suite.assertionResults : [];
    // A file with no collected tests at all is a different problem (empty file,
    // collection error already reported by vitest); only flag files that have
    // tests on paper but ran none of them.
    if (assertions.length === 0) continue;
    const executed = assertions.filter((a) => EXECUTED_STATUSES.has(a.status)).length;
    if (executed === 0) {
      offenders.push({ file: suite.name, declaredTests: assertions.length });
    }
  }
  return offenders;
}

function main() {
  const reportPath = process.argv[2];
  if (!reportPath) {
    console.error("[check-executed-test-suites] usage: <vitest-json-report>");
    process.exit(2);
  }

  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (error) {
    console.error(
      `[check-executed-test-suites] could not read vitest JSON report at ${reportPath}: ${error.message}`,
    );
    process.exit(2);
  }

  const offenders = findZeroExecutedSuites(report);
  if (offenders.length === 0) {
    return;
  }

  const allowed = process.env.PAPERCLIP_ALLOW_ZERO_EXECUTED_SUITES === "1";
  const total = offenders.reduce((sum, o) => sum + o.declaredTests, 0);
  const header = `${offenders.length} suite(s) executed zero tests, hiding ${total} test(s)`;

  if (allowed) {
    console.warn(
      `[check-executed-test-suites] WARNING: ${header}. PAPERCLIP_ALLOW_ZERO_EXECUTED_SUITES=1 is set, so this is not failing the run. CI must not set it.`,
    );
    for (const o of offenders) console.warn(`  ${o.file} (${o.declaredTests} hidden)`);
    return;
  }

  console.error(`[check-executed-test-suites] ${header}. A suite that asserts nothing cannot report success.`);
  for (const o of offenders) console.error(`  ${o.file} (${o.declaredTests} hidden)`);
  console.error(
    "[check-executed-test-suites] Common cause: the embedded-Postgres support probe failed, so `describeEmbeddedPostgres` fell back to `describe.skip`. Fix the host/probe rather than skipping. If this host genuinely cannot run embedded Postgres, set PAPERCLIP_ALLOW_ZERO_EXECUTED_SUITES=1 locally.",
  );
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
