import { readFile } from "node:fs/promises";

const required = [
  {
    file: "server/src/__tests__/cost-accounting-crash.test.ts",
    suite: "accounting survives real server SIGKILL",
    tests: ["before_receipt", "before_runtime_totals", "before_commit", "after_commit_before_delivery_ack"]
      .map(phase => `recovers exactly once after ${phase}`),
  },
  {
    file: "packages/db/src/cost-accounting-migration.test.ts",
    suite: "cost accounting historical upgrade",
    tests: [
      "preserves historical receipts, counters, references, finance currencies and incident history",
      "rejects invalid historical amounts atomically and can retry after explicit repair",
    ],
  },
];

try {
  const reports = process.argv.slice(2);
  if (reports.length !== required.length) throw new Error("Expected server and migration JSON report paths");
  for (const [index, spec] of required.entries()) {
    const report = JSON.parse(await readFile(reports[index], "utf8"));
    if (report.success !== true || !Array.isArray(report.testResults)) throw new Error(`Unsuccessful or invalid report: ${reports[index]}`);
    const files = report.testResults.filter(result => result.name?.replaceAll("\\", "/").endsWith(`/${spec.file}`));
    if (files.length !== 1 || !Array.isArray(files[0].assertionResults)) throw new Error(`Missing or duplicate suite: ${spec.file}`);
    for (const title of spec.tests) {
      const matches = files[0].assertionResults.filter(result => result.fullName === `${spec.suite} ${title}`);
      if (matches.length !== 1 || matches[0].status !== "passed") {
        throw new Error(`Required accounting test did not pass: ${spec.suite} ${title}`);
      }
    }
    process.stdout.write(`Verified ${spec.tests.length} required tests: ${spec.file}\n`);
  }
} catch (error) {
  console.error(`Accounting gate: ${error.message}`);
  process.exitCode = 1;
}
