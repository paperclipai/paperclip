import { execFile } from "node:child_process";
import { promisify } from "node:util";

const repository = "paperclipai/paperclip";
type Json = Record<string, any>;
type ReadGitHub = (endpoint: string) => Promise<Json>;
const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const timestamp = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));

async function inventory(read: ReadGitHub, endpoint: string, field: string) {
  let total: number | undefined;
  const rows: Json[] = [], ids = new Set<number>();
  for (let page = 1; page <= 10; page++) {
    const response = await read(`${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    if (!integer(response.total_count) || response.total_count > 1_000 || total !== undefined && total !== response.total_count
        || !Array.isArray(response[field]) || response[field].length > 100) throw new Error("Incomplete or changing GitHub inventory");
    total = response.total_count;
    for (const row of response[field]) {
      if (!row || !integer(row.id) || row.id < 1 || ids.has(row.id)) throw new Error("Invalid or duplicate GitHub inventory row");
      ids.add(row.id); rows.push(row);
    }
    if (rows.length === total) return rows;
    if (rows.length > total! || response[field].length < 100) throw new Error("Incomplete GitHub inventory");
  }
  throw new Error("GitHub inventory exceeds collection bound");
}

export async function readGitHubOperatingUsage(runId: string, read: ReadGitHub, now = Date.now()) {
  if (!/^[1-9][0-9]{0,15}$/.test(runId) || !Number.isSafeInteger(Number(runId)) || !Number.isFinite(now)) throw new Error("Invalid workflow run identity");
  const prefix = `repos/${repository}`;
  const repo = await read(prefix);
  const run = await read(`${prefix}/actions/runs/${runId}`);
  const validRun = (value: Json) => value.id === Number(runId) && value.repository?.id === repo.id
    && value.repository?.full_name === repository && value.path === ".github/workflows/runner-full-stack-e2e.yml"
    && value.run_attempt === 1 && value.status === "completed" && /^[a-f0-9]{40}$/.test(value.head_sha ?? "")
    && timestamp(value.created_at) && timestamp(value.run_started_at) && timestamp(value.updated_at)
    && Date.parse(value.created_at) <= Date.parse(value.run_started_at)
    && Date.parse(value.run_started_at) <= Date.parse(value.updated_at) && Date.parse(value.updated_at) <= now;
  if (!integer(repo.id) || repo.id < 1 || repo.full_name !== repository || typeof repo.private !== "boolean" || !validRun(run)) {
    throw new Error("Operating usage requires an identified, completed first-attempt Product E2E workflow");
  }
  const rawJobs = await inventory(read, `${prefix}/actions/runs/${runId}/attempts/1/jobs`, "jobs");
  if (!rawJobs.length) throw new Error("Missing workflow jobs");
  const jobs = rawJobs.map(job => {
    const skipped = job.conclusion === "skipped" && (job.runner_id === 0 || job.runner_id === null);
    if (job.run_id !== run.id || job.run_attempt !== 1 || job.status !== "completed" || !skipped && !integer(job.runner_id)
        || !Array.isArray(job.labels) || job.labels.some((label: unknown) => typeof label !== "string")) throw new Error("Invalid workflow job identity");
    if (!skipped && (!timestamp(job.started_at) || !timestamp(job.completed_at)
        || Date.parse(job.started_at) < Date.parse(run.created_at) || Date.parse(job.completed_at) > now
        || Date.parse(job.completed_at) < Date.parse(job.started_at))) throw new Error("Incomplete workflow job timing");
    const standard = job.runner_group_name === "GitHub Actions" && /^GitHub Actions [0-9]+$/.test(job.runner_name ?? "")
      && job.labels.length === 1 && job.labels[0] === "ubuntu-latest";
    return { id: job.id as number, runner: skipped ? "not_started" : standard ? "standard_github_hosted" : "other_or_unknown",
      elapsedSeconds: skipped ? 0 : (Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1_000 };
  });
  const rawArtifacts = await inventory(read, `${prefix}/actions/runs/${runId}/artifacts`, "artifacts");
  const artifacts = rawArtifacts.map(artifact => {
    if (artifact.workflow_run?.id !== run.id || artifact.workflow_run?.head_sha !== run.head_sha || !integer(artifact.size_in_bytes)
        || typeof artifact.expired !== "boolean" || !timestamp(artifact.created_at) || !timestamp(artifact.expires_at)
        || Date.parse(artifact.created_at) < Date.parse(run.created_at) || Date.parse(artifact.created_at) > now
        || Date.parse(artifact.expires_at) < Date.parse(artifact.created_at)) throw new Error("Invalid workflow artifact identity or retention");
    return { id: artifact.id as number, sizeBytes: artifact.size_in_bytes as number,
      createdAt: artifact.created_at as string, expiresAt: artifact.expires_at as string, expired: artifact.expired as boolean };
  });
  const finalRun = await read(`${prefix}/actions/runs/${runId}`);
  if (!validRun(finalRun) || ["id", "head_sha", "run_attempt", "status", "updated_at", "conclusion"].some(key => finalRun[key] !== run[key])) {
    throw new Error("Workflow changed during operating usage collection");
  }
  const retainedBytes = artifacts.filter(row => !row.expired).reduce((sum, row) => sum + row.sizeBytes, 0);
  if (!Number.isSafeInteger(retainedBytes)) throw new Error("Artifact inventory byte count overflow");
  return {
    version: 1, source: "github_actions", repository, repositoryId: repo.id as number,
    observedAt: new Date(now).toISOString(), repositoryCurrentlyPublic: !repo.private,
    runId: run.id as number, runAttempt: 1, sourceSha: run.head_sha as string,
    workflowUrl: `https://github.com/${repository}/actions/runs/${runId}`,
    startedAt: run.run_started_at as string, completedSnapshotAt: run.updated_at as string,
    queueSeconds: (Date.parse(run.run_started_at) - Date.parse(run.created_at)) / 1_000,
    summedJobSeconds: jobs.reduce((sum, row) => sum + row.elapsedSeconds, 0),
    allStartedJobsStandardHosted: jobs.every(row => row.runner !== "other_or_unknown"), jobs,
    artifacts: { inventory: artifacts, retainedBytes, lifetimeCoverage: "incomplete" },
    billing: { ciComputeUsd: null, artifactStorageUsd: null, classification: "unknown",
      publicStandardComputeRateUsdPerMinute: !repo.private && jobs.every(row => row.runner !== "other_or_unknown") ? "0" : null,
      rateSource: "https://docs.github.com/en/billing/concepts/product-billing/github-actions",
      limitations: ["Current repository visibility does not prove visibility throughout the billing window.",
        "Job elapsed time is not VM billed lifetime; queue and summed job time are separate.",
        "Artifacts already deleted are absent; returned compressed bytes and expiry are an inventory, not billed byte-hours.",
        "Caches, logs, external S3 history, model calls, observability and shared subscriptions require separate evidence."] },
  };
}

export async function collectGitHubOperatingUsage(runId: string) {
  const run = promisify(execFile);
  return readGitHubOperatingUsage(runId, async endpoint => {
    try {
      const result = await run("gh", ["api", "--hostname", "github.com", "--method", "GET", endpoint],
        { timeout: 15_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" });
      return JSON.parse(result.stdout) as Json;
    } catch { throw new Error("GitHub operating usage read failed; no retry or paid dispatch was attempted"); }
  });
}
