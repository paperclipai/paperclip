import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const suite = await import(resolve(packageRoot, "dist/conformance/capability-eval-suite.js"));
const evals = await import(resolve(packageRoot, "dist/eval/index.js"));
const packageManifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
const generatedAt = new Date().toISOString();
const evidenceMarkdown = (title, description, body) => [
  "---",
  "type: Evidence Report",
  `title: ${title}`,
  `description: ${description}`,
  `generated: { by: process:capability-live-eval, at: ${generatedAt} }`,
  "status: stable",
  "---",
  "",
  body.trimEnd(),
  "",
].join("\n");
const matrix = await suite.runCapabilityLiveCodexMatrix(process.cwd());
const providerModels = [...new Set(matrix.map(
  (entry) => `${entry.providerModel.provider}/${entry.providerModel.id}`,
))];
if (providerModels.length !== 1) {
  throw new Error(`live eval matrix used inconsistent provider models: ${providerModels.join(", ")}`);
}
const liveModel = matrix[0].providerModel;
const liveBundle = {
  schema: evals.EVAL_BUNDLE_SCHEMA,
  provider: {
    runtime: "runnerd",
    transport: "codex-app-server",
    protocolVersion: "codex-app-server-v2",
  },
  model: { id: liveModel.id },
  launchContext: {
    workingDirectoryClass: "workspace-checkout",
    scenarioId: "capability-live-codex-matrix-v1",
    turnTimeoutMs: 60_000,
  },
  promptPolicy: {
    id: "capability-live-exact-call-v1",
    callTemplate: "Call the named semantic operation exactly once with the declared JSON input.",
    restraintTemplate: "Do not call any tool for a control-plane-owned behavior.",
  },
  grants: [...suite.CAPABILITY_LIVE_EVAL_GRANTS],
  runner: {
    package: packageManifest.name,
    binary: "paperclip-runnerd",
    version: packageManifest.version,
  },
  controlPlaneAdapter: {
    kind: "mock",
    contract: "paperclip.capability.mock-state.v1",
  },
  faultInjection: [],
};
const liveObservations = matrix.map((result) => evals.observationFromLiveMatrix(result, {
  ...result.scoringEvidence,
  provenance: { source: "live_model" },
}));
const liveSliceReport = evals.buildEvalSliceReport(liveBundle, liveObservations, {
  generatedFromLiveModel: true,
});
if (liveSliceReport.aggregate.passed !== liveSliceReport.aggregate.caseCount) {
  throw new Error(`live eval slice scored ${liveSliceReport.aggregate.passed}/${liveSliceReport.aggregate.caseCount} passing cases`);
}

const faultBundle = {
  schema: evals.EVAL_BUNDLE_SCHEMA,
  provider: {
    runtime: "deterministic-harness",
    transport: "in-process",
    protocolVersion: "v1",
  },
  model: { id: "scripted-eval-agent" },
  launchContext: {
    workingDirectoryClass: "ephemeral-fixture",
    scenarioId: "eval-behavior-fault-matrix-v1",
    turnTimeoutMs: 1_000,
  },
  promptPolicy: {
    id: "deterministic-behavior-driver-v1",
    callTemplate: "Invoke the declared semantic operation sequence.",
    restraintTemplate: "Make no semantic call.",
  },
  grants: ["control_plane:wakes", "governance:approvals:decide"],
  runner: {
    package: packageManifest.name,
    binary: "node",
    version: packageManifest.version,
  },
  controlPlaneAdapter: {
    kind: "mock",
    contract: "paperclip.capability.mock-state.v1",
  },
  faultInjection: [
    { id: "fault-authz", class: "authorization", description: "deny approval decision exposure" },
    { id: "fault-conflict", class: "conflict", description: "submit a stale plan revision" },
    { id: "fault-retry", class: "retry", description: "fail the first artifact registration attempt" },
    { id: "fault-provider", class: "provider_capability", description: "omit wake scheduling from the tool surface" },
  ],
};
const behaviorMatrix = await evals.runEvalBehaviorFaultMatrix(faultBundle);
const faultSliceReport = evals.buildEvalSliceReport(
  faultBundle,
  behaviorMatrix.map((result) => result.observation),
);
const report = {
  schema: "paperclip.capability.live-codex-matrix.v1",
  groups: matrix.length,
  providerModel: liveModel,
  matrix,
};
const evidenceDirectory = resolve(packageRoot, "knowledge/evidence/capability");
const output = resolve(evidenceDirectory, "live-codex-matrix.json");
const markdown = resolve(evidenceDirectory, "live-codex-matrix.md");
const liveSliceJson = resolve(evidenceDirectory, "live-eval-slice-report.json");
const liveSliceMarkdown = resolve(evidenceDirectory, "live-eval-slice-report.md");
const faultSliceJson = resolve(evidenceDirectory, "fault-eval-slice-report.json");
const faultSliceMarkdown = resolve(evidenceDirectory, "fault-eval-slice-report.md");
await mkdir(dirname(output), { recursive: true });
await Promise.all([
  writeFile(output, `${JSON.stringify(report, null, 2)}\n`),
  writeFile(markdown, evidenceMarkdown(
    "Capability Live Codex Matrix",
    "Real Codex semantic-tool choices and resulting mock control-plane state.",
    [
    "# Capability Live Codex Matrix",
    "",
    `- Provider model: ${liveModel.provider}/${liveModel.id}`,
    `- Groups: ${report.groups}`,
    `- Cases: ${matrix.map((entry) => `${entry.group}:${entry.caseId}`).join(", ")}`,
    "- Each row asserts expected and observed typed calls plus final mock state.",
    "- Scored report: `live-eval-slice-report.md`",
    "",
    ].join("\n"),
  )),
  writeFile(liveSliceJson, `${JSON.stringify(liveSliceReport, null, 2)}\n`),
  writeFile(liveSliceMarkdown, evidenceMarkdown(
    "Live Runner Eval Slice Report",
    "Scored real-Codex capability matrix bound to its secret-free eval bundle.",
    evals.renderEvalSliceMarkdown(liveSliceReport),
  )),
  writeFile(faultSliceJson, `${JSON.stringify(faultSliceReport, null, 2)}\n`),
  writeFile(faultSliceMarkdown, evidenceMarkdown(
    "Runner Eval Fault Slice Report",
    "Eight green/red behaviors with deterministic injected-fault receipts.",
    evals.renderEvalSliceMarkdown(faultSliceReport),
  )),
]);
process.stdout.write(`Capability live Codex matrix passed: ${matrix.length} groups.\n`);
process.stdout.write(`Live eval slice passed: ${liveSliceReport.aggregate.passed}/${liveSliceReport.aggregate.caseCount}.\n`);
process.stdout.write(`Behavior fault matrix passed: ${faultSliceReport.aggregate.passed} green, ${faultSliceReport.aggregate.caseCount - faultSliceReport.aggregate.passed} scored red.\n`);
process.stdout.write(`Live matrix reports: ${output} and ${markdown}\n`);
process.stdout.write(`Scored eval reports: ${liveSliceJson}, ${liveSliceMarkdown}, ${faultSliceJson}, and ${faultSliceMarkdown}\n`);
