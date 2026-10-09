import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const evals = await import(resolve(packageRoot, "dist/eval/index.js"));
const manifest = JSON.parse(await readFile(resolve(packageRoot, "spec/evals/stress-workflow-traceability.json"), "utf8"));
const summary = evals.validateStressTraceabilityManifest(manifest);
for (const finding of manifest.findings) {
  for (const path of finding.regressionTests) await access(resolve(packageRoot, path));
}
if (summary.coveredWorkflows !== evals.RUNNER_WORKFLOW_IDS.length) {
  throw new Error(`stress traceability covers ${summary.coveredWorkflows}/${evals.RUNNER_WORKFLOW_IDS.length} workflows`);
}
process.stdout.write(`Runner stress traceability passed: ${summary.findings} findings, ${summary.coveredWorkflows} workflows, ${summary.exclusions} explicit exclusion.\n`);
