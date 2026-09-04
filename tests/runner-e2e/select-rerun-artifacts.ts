import { cp, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { RunnerE2EResult } from "./types.js";

interface WorkflowJob {
  name: string;
  run_attempt: number;
  started_at: string;
}

interface WorkflowJobsResponse {
  jobs: WorkflowJob[];
  attempts: Array<{
    run_attempt: number;
    run_started_at: string;
  }>;
}

export interface SelectRerunArtifactsInput {
  artifactRoot: string;
  selectedRoot: string;
  jobs: WorkflowJobsResponse;
  expectedExecutionIds: readonly string[];
  workflowRunId: string;
  workflowRunAttempt: number;
  sourceSha: string;
  sourceRef: string;
  workflowRunUrl: string;
}

function safeIdentifier(value: string, label: string) {
  if (!value || !/^[A-Za-z0-9_.-]+$/u.test(value)) {
    throw new Error(
      `${label} contains unsafe characters: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function positiveInteger(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function timestamp(value: unknown, label: string) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return Date.parse(value);
}

async function walk(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

/**
 * Selects the artifact produced by the latest workflow job for each execution.
 * GitHub reruns retain earlier-attempt artifacts, so validity or result
 * timestamps must never be used to choose between workflow attempts.
 */
export async function selectRerunArtifacts(input: SelectRerunArtifactsInput) {
  const runId = safeIdentifier(input.workflowRunId, "workflow run ID");
  const currentAttempt = positiveInteger(
    input.workflowRunAttempt,
    "workflow run attempt",
  );
  const expected = input.expectedExecutionIds.map((executionId) =>
    safeIdentifier(executionId, "execution ID"),
  );
  if (expected.length === 0 || new Set(expected).size !== expected.length) {
    throw new Error("expected execution IDs must be non-empty and unique");
  }
  const preexistingSelections = await readdir(input.selectedRoot).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  if (preexistingSelections.length > 0) {
    throw new Error("selected artifact root must start empty");
  }
  const expectedSet = new Set(expected);
  const attemptStartedAt = new Map<number, number>();
  for (const attemptMetadata of input.jobs.attempts) {
    const attempt = positiveInteger(
      attemptMetadata.run_attempt,
      "workflow metadata attempt",
    );
    if (attempt > currentAttempt || attemptStartedAt.has(attempt)) {
      throw new Error(`invalid workflow metadata for attempt ${attempt}`);
    }
    attemptStartedAt.set(
      attempt,
      timestamp(
        attemptMetadata.run_started_at,
        `workflow attempt ${attempt} start`,
      ),
    );
  }
  for (let attempt = 1; attempt <= currentAttempt; attempt += 1) {
    if (!attemptStartedAt.has(attempt)) {
      throw new Error(`workflow metadata omitted attempt ${attempt}`);
    }
  }
  const attemptsByExecution = new Map<string, Map<number, WorkflowJob>>();
  for (const candidate of input.jobs.jobs) {
    if (!expectedSet.has(candidate.name)) continue;
    const attempt = positiveInteger(candidate.run_attempt, "job run attempt");
    if (attempt > currentAttempt) {
      throw new Error(
        `job ${candidate.name} claims future workflow attempt ${attempt}`,
      );
    }
    const jobStartedAt = timestamp(
      candidate.started_at,
      `job ${candidate.name} start`,
    );
    // GitHub's filter=all response synthesizes current-attempt rows for jobs
    // retained from an earlier attempt. Their started_at remains before the
    // current attempt's trusted run_started_at, so they are not real reruns.
    if (jobStartedAt < attemptStartedAt.get(attempt)!) continue;
    const attempts = attemptsByExecution.get(candidate.name) ?? new Map();
    if (attempts.has(attempt)) {
      throw new Error(
        `workflow attempt ${attempt} contains duplicate job ${candidate.name}`,
      );
    }
    attempts.set(attempt, candidate);
    attemptsByExecution.set(candidate.name, attempts);
  }

  const latestAttemptByExecution = new Map<string, number>();
  for (const executionId of expected) {
    const attempts = [...(attemptsByExecution.get(executionId)?.keys() ?? [])];
    if (attempts.length === 0) {
      throw new Error(
        `workflow job history omitted expected execution ${executionId}`,
      );
    }
    latestAttemptByExecution.set(executionId, Math.max(...attempts));
  }

  const recognizedArtifactNames = new Map<
    string,
    { executionId: string; workflowAttempt: number }
  >();
  for (const executionId of expected) {
    for (const workflowAttempt of attemptsByExecution
      .get(executionId)!
      .keys()) {
      recognizedArtifactNames.set(
        `runner-e2e-${runId}-${workflowAttempt}-${executionId}`,
        { executionId, workflowAttempt },
      );
    }
  }

  const artifactEntries = await readdir(input.artifactRoot, {
    withFileTypes: true,
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const artifactDirectories = new Map<string, string>();
  for (const entry of artifactEntries) {
    const identity = recognizedArtifactNames.get(entry.name);
    if (!identity || !entry.isDirectory()) {
      throw new Error(`downloaded unexpected runner artifact ${entry.name}`);
    }
    artifactDirectories.set(
      entry.name,
      path.join(input.artifactRoot, entry.name),
    );
  }

  const selections: Array<{
    executionId: string;
    workflowAttempt: number;
    artifactName: string;
  }> = [];
  for (const executionId of expected) {
    const workflowAttempt = latestAttemptByExecution.get(executionId)!;
    const artifactName = `runner-e2e-${runId}-${workflowAttempt}-${executionId}`;
    const artifactDirectory = artifactDirectories.get(artifactName);
    // A latest job without an artifact must remain missing. Falling back to an
    // older successful artifact would mask an infrastructure/upload failure.
    if (!artifactDirectory) continue;

    const campaignName = `gha-${runId}-${workflowAttempt}-${executionId}`;
    const topLevelEntries = await readdir(artifactDirectory, {
      withFileTypes: true,
    });
    if (
      topLevelEntries.length !== 1 ||
      topLevelEntries[0]?.name !== campaignName ||
      !topLevelEntries[0].isDirectory()
    ) {
      throw new Error(
        `${artifactName} must contain only its exact campaign ${campaignName}`,
      );
    }
    const campaignDirectory = path.join(artifactDirectory, campaignName);
    const resultFiles = (await walk(campaignDirectory)).filter(
      (file) => path.basename(file) === "result.json",
    );
    if (resultFiles.length === 0) {
      throw new Error(`${artifactName} contains no normalized result`);
    }
    for (const resultFile of resultFiles) {
      const result = JSON.parse(
        await readFile(resultFile, "utf8"),
      ) as RunnerE2EResult;
      if (result.executionId !== executionId) {
        throw new Error(
          `${artifactName} contains result for ${String(result.executionId)}`,
        );
      }
      const source = result.source;
      if (
        !source ||
        source.sha !== input.sourceSha ||
        source.ref !== input.sourceRef ||
        source.workflowRunUrl !== input.workflowRunUrl
      ) {
        throw new Error(`${artifactName} contains result from another source`);
      }
    }
    const destination = path.join(
      input.selectedRoot,
      artifactName,
      campaignName,
    );
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(campaignDirectory, destination, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    selections.push({ executionId, workflowAttempt, artifactName });
  }
  return selections;
}

async function main() {
  const required = (name: string) => {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const expected = JSON.parse(
    required("PAPERCLIP_RUNNER_E2E_EXPECTED_IDS"),
  ) as unknown;
  if (
    !Array.isArray(expected) ||
    expected.some((value) => typeof value !== "string")
  ) {
    throw new Error(
      "PAPERCLIP_RUNNER_E2E_EXPECTED_IDS must be a JSON string array",
    );
  }
  const jobs = JSON.parse(
    await readFile(required("PAPERCLIP_RUNNER_E2E_JOBS_JSON"), "utf8"),
  ) as WorkflowJobsResponse;
  if (!jobs || !Array.isArray(jobs.jobs) || !Array.isArray(jobs.attempts)) {
    throw new Error("workflow jobs JSON must contain jobs and attempts arrays");
  }
  const runId = required("GITHUB_RUN_ID");
  const serverUrl = required("GITHUB_SERVER_URL");
  const repository = required("GITHUB_REPOSITORY");
  const selections = await selectRerunArtifacts({
    artifactRoot: required("PAPERCLIP_RUNNER_E2E_ARTIFACT_ROOT"),
    selectedRoot: required("PAPERCLIP_RUNNER_E2E_SELECTED_ROOT"),
    jobs,
    expectedExecutionIds: expected,
    workflowRunId: runId,
    workflowRunAttempt: Number(required("GITHUB_RUN_ATTEMPT")),
    sourceSha: required("PAPERCLIP_RUNNER_E2E_SOURCE_SHA"),
    sourceRef: required("PAPERCLIP_RUNNER_E2E_SOURCE_REF"),
    workflowRunUrl: `${serverUrl}/${repository}/actions/runs/${runId}`,
  });
  console.log(
    `Selected ${selections.length}/${expected.length} latest cell artifacts`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
