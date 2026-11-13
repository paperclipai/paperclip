import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";

import { renderRunnerWorkflowWithCanonicalEvalbook } from "./render-runner-workflow-evalbook.mjs";

const packageRoot = resolve(import.meta.dirname, "..");
const evals = await import(resolve(packageRoot, "dist/eval/index.js"));
const packageManifest = JSON.parse(
  await readFile(resolve(packageRoot, "package.json"), "utf8"),
);
const modeIndex = process.argv.indexOf("--mode");
const mode = modeIndex < 0 ? "nightly" : process.argv[modeIndex + 1];
const execute = process.argv.includes("--execute");
if (mode !== "nightly" && mode !== "chaos")
  throw new Error(`unsupported workflow eval schedule mode: ${mode}`);
const now = process.env.PAPERCLIP_EVAL_GENERATED_AT ?? new Date().toISOString();
const rotationDay = Number(
  process.env.PAPERCLIP_EVAL_ROTATION_DAY ?? evals.runnerLiveRotationWeek(now),
);
const seed =
  process.env.PAPERCLIP_EVAL_SCHEDULE_SEED ?? "runner-live-seven-week-v1";
const outputDirectory = resolve(
  packageRoot,
  ".paperclip-local/evals/workflows",
);
const historyDirectory = resolve(
  process.env.PAPERCLIP_EVAL_HISTORY_DIR ?? resolve(outputDirectory, "history"),
);
await mkdir(outputDirectory, { recursive: true });

function selectorValues(flag, environmentName) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== flag) continue;
    const value = process.argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a comma-separated value`);
    }
    values.push(value);
  }
  if (process.env[environmentName]) values.push(process.env[environmentName]);
  return [
    ...new Set(
      values.flatMap((value) =>
        value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
      ),
    ),
  ];
}

function selectionLimit() {
  const index = process.argv.indexOf("--limit");
  const raw =
    index < 0 ? process.env.PAPERCLIP_EVAL_LIMIT : process.argv[index + 1];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("--limit must be a positive integer");
  }
  return value;
}

const selection = {
  candidateIds: selectorValues("--candidate", "PAPERCLIP_EVAL_CANDIDATE"),
  caseIds: selectorValues("--case", "PAPERCLIP_EVAL_CASE"),
  limit: selectionLimit(),
};
const selectionActive =
  selection.candidateIds.length > 0 ||
  selection.caseIds.length > 0 ||
  selection.limit !== undefined;

function safeBundleId(schedule) {
  const runnerBuild =
    process.env.PAPERCLIP_EVAL_RUNNER_BUILD ?? packageManifest.version;
  const identity = JSON.stringify({
    runnerVersion: packageManifest.version,
    runnerBuild,
    promptPolicyId: "runner-live-workflow-v1",
    seed: schedule.seed,
    candidates: schedule.candidates.map(
      ({ id, adapter, model, reasoningEffort }) => ({
        id,
        adapter,
        model,
        reasoningEffort,
      }),
    ),
    ...(selectionActive
      ? {
          selectedExecutions: schedule.entries.map(
            (entry) => entry.executionId,
          ),
        }
      : {}),
  });
  return `runner-live-v2-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
}

function qualificationFailure(entry, candidate, evalCase) {
  const missing = candidate.qualification.requiredEnvironment.filter(
    (name) => !process.env[name],
  );
  if (missing.length === 0) return null;
  return evals.unavailableLiveRunnerWorkflowObservation({
    entry,
    candidate,
    evalCase,
    classification: "skipped",
    code: "qualification_environment_missing",
    category: "qualification",
    retryable: false,
    message: `Required credential reference unavailable: ${missing.join(", ")}`,
  });
}

async function readCompatibleHistory(bundleId) {
  const names = await readdir(historyDirectory).catch(() => []);
  const reports = [];
  for (const name of names.filter((value) => value.endsWith(".json")).sort()) {
    try {
      const report = JSON.parse(
        await readFile(resolve(historyDirectory, name), "utf8"),
      );
      if (
        report?.schema === evals.RUNNER_WORKFLOW_REPORT_SCHEMA &&
        report?.bundle?.id === bundleId
      )
        reports.push(report);
    } catch {
      // A malformed historical artifact is ignored; it cannot affect the current candidate score.
    }
  }
  return reports.slice(-7);
}

async function retainHistory(report) {
  await mkdir(historyDirectory, { recursive: true });
  const stamp = report.generatedAt.replaceAll(/[^0-9A-Za-z.-]/g, "-");
  await writeFile(
    resolve(historyDirectory, `${stamp}-${report.bundle.id}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  // Candidate sets alternate, so seven compatible weekly baselines require
  // roughly fourteen weeks of history. Keep a little extra scheduling margin.
  const expiry = Date.now() - 120 * 24 * 60 * 60 * 1_000;
  for (const name of await readdir(historyDirectory)) {
    if (!name.endsWith(".json")) continue;
    const metadata = await stat(resolve(historyDirectory, name));
    if (metadata.mtimeMs < expiry) await rm(resolve(historyDirectory, name));
  }
}

if (mode === "nightly") {
  const fullSchedule = evals.buildRunnerLiveEvalSchedule({
    seed,
    rotationDay,
    generatedAt: now,
  });
  const coverage = evals.runnerLiveScheduleCoverage(seed);
  if (!Object.values(coverage).every(Boolean))
    throw new Error(
      `live schedule coverage failed: ${JSON.stringify(coverage)}`,
    );
  const schedule = selectionActive
    ? evals.selectRunnerLiveEvalSchedule(fullSchedule, selection)
    : fullSchedule;
  await writeFile(
    resolve(outputDirectory, "nightly-schedule.json"),
    `${JSON.stringify({ schedule, coverage, selection: selectionActive ? selection : null }, null, 2)}\n`,
  );
  if (!execute) {
    process.stdout.write(
      `Runner live eval schedule ready: ${schedule.expectedExecutions} executions, rotation week ${schedule.rotationDay}. Use --execute to run providers.\n`,
    );
    process.exit(0);
  }

  const campaignCostLimit = evals.parseRunnerLiveCampaignCostLimit(
    process.env.PAPERCLIP_EVAL_MAX_CAMPAIGN_COST_USD,
  );
  let observedCampaignCost = 0;
  const observations = await evals.executeRunnerLiveSchedule(
    schedule,
    async (entry, candidate) => {
      const evalCase = evals.runnerWorkflowCase(entry.caseId);
      const unavailable = qualificationFailure(entry, candidate, evalCase);
      if (unavailable) return unavailable;
      if (observedCampaignCost >= campaignCostLimit) {
        return evals.unavailableLiveRunnerWorkflowObservation({
          entry,
          candidate,
          evalCase,
          classification: "skipped",
          code: "campaign_cost_ceiling_reached",
          category: "orchestration",
          retryable: false,
          message: `Campaign cost ceiling reached before this execution (${campaignCostLimit} USD)`,
        });
      }
      const observation = await evals.executeLiveRunnerWorkflow({
        entry,
        candidate,
        evalCase,
      });
      observedCampaignCost += observation.metrics.costUsd ?? 0;
      return observation;
    },
    (entry, candidate, error) =>
      evals.unavailableLiveRunnerWorkflowObservation({
        entry,
        candidate,
        evalCase: evals.runnerWorkflowCase(entry.caseId),
        classification: "infrastructure_failure",
        code: error.code,
        category: "provider",
        retryable: error.retryable,
        message: error.message,
      }),
  );
  const bundleId = safeBundleId(schedule);
  const results = observations.map((observation) => ({
    scenarioId: observation.caseId,
    candidateId: observation.candidateId,
    observation,
    scorecard: evals.scoreRunnerWorkflow(observation, { bundleId }),
  }));
  const providerVersions = Object.fromEntries(
    schedule.candidates.map((candidate) => [
      candidate.id,
      `${candidate.adapter}:${candidate.model}`,
    ]),
  );
  const report = evals.buildRunnerWorkflowEvalReport({
    source: "live",
    bundle: {
      id: bundleId,
      runnerVersion: packageManifest.version,
      runnerBuild:
        process.env.PAPERCLIP_EVAL_RUNNER_BUILD ?? packageManifest.version,
      promptPolicyId: "runner-live-workflow-v1",
      providerVersions,
      scheduleSeed: schedule.seed,
    },
    results,
    generatedAt: now,
  });
  const history = await readCompatibleHistory(bundleId);
  const comparison =
    history.length === 0
      ? null
      : evals.compareRunnerWorkflowReports(report, history.at(-1));
  const alerts = evals.runnerWorkflowAlerts({
    current: report,
    history,
    baselineReady:
      process.env.PAPERCLIP_EVAL_BASELINE_READY === "true" &&
      history.length >= 7,
  });
  await Promise.all([
    writeFile(
      resolve(outputDirectory, "live-report.json"),
      `${JSON.stringify({ report, alerts, comparison }, null, 2)}\n`,
    ),
    writeFile(
      resolve(outputDirectory, "live-report.md"),
      evals.renderRunnerWorkflowMarkdown(report),
    ),
    writeFile(
      resolve(outputDirectory, "live-report.junit.xml"),
      evals.renderRunnerWorkflowJUnit(report),
    ),
    writeFile(
      resolve(outputDirectory, "github-live-summary.md"),
      `${evals.renderRunnerWorkflowGitHubSummary(report, alerts)}\n## Previous compatible bundle\n\n${comparison === null ? "No compatible prior bundle is available." : `Pass-rate delta: ${comparison.passRateDelta}; overall delta: ${comparison.overallDelta}.`}\n`,
    ),
  ]);
  await renderRunnerWorkflowWithCanonicalEvalbook({
    packageRoot,
    outputDirectory,
    report,
    caseForId: evals.runnerWorkflowCase,
  });
  await retainHistory(report);
  process.stdout.write(
    `Runner live evals complete: ${report.aggregate.passed}/${report.aggregate.scoreable} scoreable passed; ${report.aggregate.infrastructureFailures} infrastructure, ${report.aggregate.skipped} skipped, ${alerts.length} alert(s). Open ${resolve(outputDirectory, "index.html")}.\n`,
  );
} else {
  const payload = {
    schema: "paperclip.runner.chaos-eval-schedule.v1",
    generatedAt: now,
    seed,
    scenarios: evals.RUNNER_CHAOS_SCENARIOS,
  };
  await writeFile(
    resolve(outputDirectory, "chaos-schedule.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
  process.stdout.write(
    `Runner chaos eval schedule ready: ${payload.scenarios.length} scenarios.\n`,
  );
}
