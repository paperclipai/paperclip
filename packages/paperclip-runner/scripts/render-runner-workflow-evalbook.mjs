import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const EVAL_PROGRAM_RELATIVE_PATH =
  "evals/paperclip-runner/tools/eval_program.py";

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeSegment(value) {
  const segment = String(value)
    .trim()
    .replaceAll(/[^0-9A-Za-z._-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  if (!segment) throw new Error("Evalbook attempt identity is empty");
  return segment;
}

function candidateDescriptor(report, candidateId) {
  const descriptor =
    report.bundle.providerVersions?.[candidateId] ?? candidateId;
  const separator = descriptor.indexOf(":");
  return separator < 0
    ? { driver: "unknown driver", model: descriptor }
    : {
        driver: descriptor.slice(0, separator),
        model: descriptor.slice(separator + 1),
      };
}

function scoreChecks(result) {
  const dimensionChecks = Object.values(result.scorecard.dimensions).map(
    (dimension) => ({
      id: dimension.dimension,
      kind: "workflow_dimension",
      passed: dimension.passed === true,
      detail:
        dimension.score === null
          ? dimension.reasons.join("; ") || "not scored"
          : `score ${dimension.score}${
              dimension.reasons.length === 0
                ? ""
                : `; ${dimension.reasons.join("; ")}`
            }`,
      evidenceRefs: [],
    }),
  );
  const observationChecks = [
    ["lifecycle", result.observation.lifecycle?.checks ?? []],
    ["continuation", result.observation.continuation?.checks ?? []],
    ["presentation", result.observation.presentation?.checks ?? []],
  ].flatMap(([group, checks]) =>
    checks.map((check) => ({
      id: `${group}.${check.id}`,
      kind: `${group}_check`,
      passed: check.passed === true,
      detail: check.reason ?? (check.passed ? "passed" : "failed"),
      evidenceRefs: [],
    })),
  );
  return [...dimensionChecks, ...observationChecks];
}

function disposition(result) {
  if (result.scorecard.overall.passed === true) return "passed";
  if (
    result.observation.classification === "infrastructure_failure" ||
    result.observation.classification === "skipped"
  ) {
    return "infrastructure_failure";
  }
  return "behavior_failure";
}

function infrastructureErrors(result) {
  if (disposition(result) !== "infrastructure_failure") return [];
  return [
    result.observation.failure?.message ??
      `workflow execution was ${result.observation.classification}`,
  ];
}

export function runnerWorkflowEvalbookAttempt({
  report,
  result,
  caseDefinition,
}) {
  const { driver, model } = candidateDescriptor(report, result.candidateId);
  const identity = {
    generatedAt: report.generatedAt,
    bundleId: report.bundle.id,
    caseId: result.scenarioId,
    candidateId: result.candidateId,
  };
  const timestamp = safeSegment(report.generatedAt);
  const attemptId = `${timestamp}-${safeSegment(result.scenarioId)}-${safeSegment(
    result.candidateId,
  )}-${sha256(JSON.stringify(identity)).slice(0, 10)}`;
  const checks = scoreChecks(result);
  const costUsd = result.observation.metrics.costUsd;
  const infrastructure =
    disposition(result) === "infrastructure_failure"
      ? result.observation.failure
      : undefined;
  const artifact = {
    schema: "paperclip-runner/workflow-eval-artifact/v1",
    attemptId,
    createdAt: report.generatedAt,
    requestedModel: model,
    provider: result.observation.provider,
    driver,
    providerVersion:
      report.bundle.runnerBuild ?? report.bundle.runnerVersion ?? "unknown",
    providerSessionId: result.observation.base.trace.sessionId,
    retainedSession: false,
    retainedSessionStatus: "not retained by safe workflow eval projection",
    usage: {
      agentTurns: result.observation.metrics.attempts,
      inputTokens: result.observation.metrics.totalTokens,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      ...(costUsd === undefined
        ? {}
        : { estimatedCostNanodollars: Math.round(costUsd * 1_000_000_000) }),
    },
    turn: {
      status:
        result.observation.classification === "completed"
          ? "completed"
          : "failed",
    },
    snapshot: {
      createdAt: report.generatedAt,
      providerModel: {
        id: model,
        provider: result.observation.provider,
      },
      transcript: [],
      evidence: [],
    },
    devtools: { revisions: [] },
    ...(infrastructure === undefined
      ? {}
      : {
          infrastructureFailure: {
            class: infrastructure.code,
            category: infrastructure.category,
            retryable: infrastructure.retryable,
          },
        }),
    workflow: {
      bundle: report.bundle,
      observation: result.observation,
      scorecard: result.scorecard,
    },
  };
  const score = {
    schema: "paperclip-runner/eval-score/v1",
    attemptId,
    caseId: result.scenarioId,
    checks,
    disposition: disposition(result),
    infrastructureErrors: infrastructureErrors(result),
    passed: result.scorecard.overall.passed === true,
    digest: `sha256:${sha256(JSON.stringify({ identity, checks }))}`,
  };
  const evalCase = {
    schema: "paperclip-runner/workflow-eval-case/v1",
    id: result.scenarioId,
    title: caseDefinition?.title ?? result.scenarioId,
    description: caseDefinition
      ? `Runner workflow case. Tags: ${caseDefinition.tags.join(", ")}.`
      : "Runner workflow case.",
    prompt:
      "Redacted by the safe Runner workflow eval projection; inspect the authored workflow case for orchestration steps.",
    fixture: "runner-workflow-live-harness",
    authority: {
      controlPlaneOwned: result.observation.base.controlPlaneOwned,
    },
    checks: Object.entries(caseDefinition?.assertions ?? {}).map(
      ([id, expected]) => ({
        id,
        kind: "workflow_assertion",
        expected,
      }),
    ),
    ...(caseDefinition === undefined
      ? {}
      : { workflowDefinition: caseDefinition }),
  };
  const config = {
    schema: "paperclip-runner/workflow-eval-config/v1",
    id: result.candidateId,
    model,
    provider: result.observation.provider,
    driver,
    runnerVersion: report.bundle.runnerVersion,
    runnerBuild: report.bundle.runnerBuild,
    promptPolicyId: report.bundle.promptPolicyId,
  };
  return { attemptId, artifact, score, case: evalCase, config };
}

async function writeImmutable(path, value) {
  const content = json(value);
  try {
    const existing = await readFile(path, "utf8");
    if (existing !== content) {
      throw new Error(`Immutable Evalbook record changed: ${path}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await writeFile(path, content, { flag: "wx", mode: 0o600 });
  }
}

export async function writeRunnerWorkflowEvalbookAttempts({
  report,
  runsRoot,
  caseForId,
}) {
  await mkdir(runsRoot, { recursive: true });
  const attempts = [];
  for (const result of report.results) {
    const attempt = runnerWorkflowEvalbookAttempt({
      report,
      result,
      caseDefinition: caseForId?.(result.scenarioId),
    });
    const directory = resolve(runsRoot, attempt.attemptId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await Promise.all([
      writeImmutable(resolve(directory, "artifact.json"), attempt.artifact),
      writeImmutable(resolve(directory, "score.json"), attempt.score),
      writeImmutable(resolve(directory, "case.json"), attempt.case),
      writeImmutable(resolve(directory, "config.json"), attempt.config),
    ]);
    attempts.push(attempt.attemptId);
  }
  return attempts;
}

async function existingPath(paths) {
  for (const path of paths.filter(Boolean)) {
    try {
      await access(path);
      return resolve(path);
    } catch {
      // Continue through the explicit and conventional checkout locations.
    }
  }
  return null;
}

export async function resolveCanonicalEvalProgram(packageRoot, environment) {
  const fromRoot = environment.PAPERCLIP_EVALS_ROOT
    ? resolve(environment.PAPERCLIP_EVALS_ROOT, EVAL_PROGRAM_RELATIVE_PATH)
    : null;
  const program = await existingPath([
    environment.PAPERCLIP_EVALBOOK_PROGRAM,
    fromRoot,
    resolve(packageRoot, "../../.paperclip-evals", EVAL_PROGRAM_RELATIVE_PATH),
    resolve(
      packageRoot,
      "../../../paperclip-evals",
      EVAL_PROGRAM_RELATIVE_PATH,
    ),
    resolve(
      packageRoot,
      "../../../../paperclip-evals",
      EVAL_PROGRAM_RELATIVE_PATH,
    ),
  ]);
  if (program !== null) return program;
  throw new Error(
    `Canonical Evalbook generator not found. Set PAPERCLIP_EVALBOOK_PROGRAM to ${EVAL_PROGRAM_RELATIVE_PATH} in a paperclip-evals checkout.`,
  );
}

async function run(command, args) {
  await new Promise((accept, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) accept();
      else
        reject(
          new Error(
            `${command} exited ${code ?? `for signal ${signal ?? "unknown"}`}`,
          ),
        );
    });
  });
}

export async function renderRunnerWorkflowWithCanonicalEvalbook({
  packageRoot,
  outputDirectory,
  report,
  caseForId,
  environment = process.env,
}) {
  const program = await resolveCanonicalEvalProgram(packageRoot, environment);
  const runsRoot = resolve(outputDirectory, "evalbook-runs");
  await rm(runsRoot, { recursive: true, force: true });
  const attempts = await writeRunnerWorkflowEvalbookAttempts({
    report,
    runsRoot,
    caseForId,
  });
  await Promise.all([
    rm(resolve(outputDirectory, "attempts"), { recursive: true, force: true }),
    rm(resolve(outputDirectory, "tests"), { recursive: true, force: true }),
    rm(resolve(outputDirectory, "index.html"), { force: true }),
    rm(resolve(outputDirectory, "latest.html"), { force: true }),
    rm(resolve(outputDirectory, "live-report.html"), { force: true }),
    rm(resolve(outputDirectory, "deterministic-report.html"), { force: true }),
  ]);
  await run(environment.PYTHON ?? "python3", [
    program,
    "report",
    "--runs-root",
    runsRoot,
    "--output",
    outputDirectory,
  ]);
  const programBytes = await readFile(program);
  const manifest = {
    schema: "paperclip.runner.workflow-evalbook-render.v1",
    generatedAt: report.generatedAt,
    generator: {
      path: program,
      sha256: `sha256:${sha256(programBytes)}`,
    },
    sourceReport: "live-report.json",
    attempts,
    index: resolve(outputDirectory, "index.html"),
  };
  await writeFile(
    resolve(outputDirectory, "evalbook-manifest.json"),
    json(manifest),
  );
  return manifest;
}
