import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const evals = await import(resolve(packageRoot, "dist/eval/index.js"));
const packageManifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
const traceability = JSON.parse(await readFile(resolve(packageRoot, "spec/evals/stress-workflow-traceability.json"), "utf8"));
const traceabilitySummary = evals.validateStressTraceabilityManifest(traceability);
const results = await evals.runDeterministicRunnerWorkflowMatrix({ bundleId: "runner-workflows-deterministic-v1" });
const report = evals.buildRunnerWorkflowEvalReport({
  source: "deterministic",
  bundle: {
    id: "runner-workflows-deterministic-v1",
    runnerVersion: packageManifest.version,
    promptPolicyId: "stress-sanitized-v1",
    providerVersions: { codex: "fixture-v1", opencode: "fixture-v1", acpx: "fixture-v1" },
  },
  results,
  traceability: traceabilitySummary,
});
if (report.aggregate.passed !== report.aggregate.scoreable) {
  throw new Error(`Runner workflow evals passed ${report.aggregate.passed}/${report.aggregate.scoreable}`);
}
const outputDirectory = resolve(packageRoot, ".paperclip-local/evals/workflows");
await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(resolve(outputDirectory, "deterministic-report.json"), `${JSON.stringify(report, null, 2)}\n`),
  writeFile(resolve(outputDirectory, "deterministic-report.md"), evals.renderRunnerWorkflowMarkdown(report)),
  writeFile(resolve(outputDirectory, "deterministic-report.junit.xml"), evals.renderRunnerWorkflowJUnit(report)),
  writeFile(resolve(outputDirectory, "github-summary.md"), evals.renderRunnerWorkflowGitHubSummary(report)),
]);
process.stdout.write(`Runner workflow evals passed: ${report.aggregate.passed}/${report.aggregate.scoreable}; coverage ${report.coverage.canonicalOperations} operations, ${report.coverage.capabilityCases} capability cases, ${report.coverage.workflows} workflows.\n`);
