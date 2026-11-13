// A Cloud readiness attempt that failed only because AWS Spot workers were
// reclaimed proves nothing about the source. Before this module, the first
// lost runner failed the release's source gate, the image watcher cancelled
// the readiness run, and nothing retried it: on 2026-11-13 a 13:49:56Z fleet
// reclaim held every release containing #21266 until a person re-ran the run.
//
// Both waiters (the npm canary gate in release.yml and the image watcher in
// docker.yml) call this when the source proof fails. A failure whose every
// causing job lost its runner re-runs the failed jobs instead, up to a fixed
// attempt ceiling. A real check failure still fails closed: it is never
// retried here.
import { classifyJob, createGithubClient } from "../.github/scripts/runner-loss-rerun.mjs";

const repository = "paperclipai/paperclip";
const workflowPath = ".github/workflows/cloud-readiness.yml";
// Attempt 1 is often the deferred admission-only pass and attempt 2 the
// admitted full run, so 4 allows at least two runner-loss retries. The ceiling
// is stateless: every waiter of every release attempt agrees on it.
export const maxRunnerLossAttempt = 4;
// A causing job ended the attempt on its own. Cancelled jobs are fallout from
// that failure (the image watcher or a reusable workflow cancelled them).
const causeConclusions = new Set(["failure", "timed_out", "startup_failure"]);
const nonGating = name => name.startsWith("Runner chaos evals (not a publication gate) / ");

function trusted(run, sha, runId) {
  return run?.id === runId && run.path === workflowPath && run.head_sha === sha && run.head_branch === "master" &&
    run.event === "push" && run.repository?.full_name === repository && run.head_repository?.full_name === repository &&
    Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0;
}

async function attemptJobs(api, runId, attempt) {
  const jobs = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await api(`/repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`);
    if (!Array.isArray(batch.jobs)) throw new Error("Cloud readiness job listing is malformed.");
    jobs.push(...batch.jobs);
    if (batch.jobs.length < 100) return jobs;
  }
  throw new Error("Cloud readiness job listing is incomplete.");
}

/** Which failed jobs lost their runner. `lost` is true only when at least one
 * job lost its runner and no job failed for any other reason. */
export async function classifyAttempt(jobs, { readAnnotations, readLog }) {
  const ended = jobs.filter(job => job.status === "completed" && !nonGating(job.name ?? ""));
  const causes = ended.filter(job => causeConclusions.has(job.conclusion));
  // A reclaimed worker sometimes concludes its job `cancelled`. With no other
  // cause, a cancelled job counts only when its own log shows the loss.
  const candidates = causes.length ? causes : ended.filter(job => job.conclusion === "cancelled");
  const results = [];
  for (const job of candidates) {
    try {
      results.push({ id: job.id, name: job.name, conclusion: job.conclusion,
        ...(await classifyJob(job, { annotations: await readAnnotations(job), readLog })) });
    } catch (error) {
      results.push({ id: job.id, name: job.name, conclusion: job.conclusion, lost: false, evidence: `could not read job evidence: ${error.message}` });
    }
  }
  const lost = causes.length ? results.length > 0 && results.every(job => job.lost) : results.some(job => job.lost);
  return { lost, jobs: results };
}

/**
 * Called after a source proof read failed for `failure.runId`/`failure.attempt`.
 * Returns "retrying" when the waiter should keep waiting (a runner-loss retry
 * was requested, is pending, or a newer attempt already exists) and "failed"
 * when the failure stands.
 */
export async function retryRunnerLoss({ sha, failure, api, readAnnotations, readLog, cancel, rerunFailed, log = console.log }) {
  const run = await api(`/repos/${repository}/actions/runs/${failure.runId}`);
  if (!trusted(run, sha, failure.runId)) throw new Error("Cloud readiness identity changed before a runner-loss retry.");
  // Someone (another waiter or a person) already started the next attempt.
  if (run.run_attempt > failure.attempt) return "retrying";
  if (run.run_attempt !== failure.attempt) return "failed";
  const jobs = (await attemptJobs(api, run.id, run.run_attempt))
    .filter(job => job.run_id === run.id && job.run_attempt === run.run_attempt && job.head_sha === sha);
  const verdict = await classifyAttempt(jobs, { readAnnotations, readLog });
  for (const job of verdict.jobs) log(`Cloud readiness ${run.id} attempt ${run.run_attempt}: ${job.name} ${job.lost ? "lost its runner" : "failed"} (${job.evidence}).`);
  if (!verdict.lost) return "failed";
  if (run.run_attempt >= maxRunnerLossAttempt) {
    log(`Cloud readiness ${run.id} lost runners on attempt ${run.run_attempt}, the last automatic attempt.`);
    return "failed";
  }
  // Re-running failed jobs needs a completed run. Healthy jobs still running
  // would be repeated anyway once they are cancelled, so end the attempt now.
  if (run.status !== "completed") {
    // Job evidence reads take time. Another waiter may have ended this attempt
    // and started the next one meanwhile: never cancel a newer attempt.
    const fresh = await api(`/repos/${repository}/actions/runs/${run.id}`);
    if (!trusted(fresh, sha, run.id)) throw new Error("Cloud readiness identity changed before a runner-loss retry.");
    if (fresh.run_attempt !== run.run_attempt || fresh.status === "completed") return "retrying";
    log(`Cloud readiness ${run.id} attempt ${run.run_attempt} lost its runner; ending the attempt to retry its failed jobs.`);
    try {
      await cancel(`/repos/${repository}/actions/runs/${run.id}/cancel`);
    } catch (error) {
      // The attempt finished or was cancelled by the other waiter first.
      const latest = await api(`/repos/${repository}/actions/runs/${run.id}`);
      if (!trusted(latest, sha, run.id)) throw error;
      if (latest.run_attempt > run.run_attempt || latest.status === "completed" || [409, 422].includes(error.status)) return "retrying";
      throw error;
    }
    return "retrying";
  }
  try {
    await rerunFailed(`/repos/${repository}/actions/runs/${run.id}/rerun-failed-jobs`);
    log(`Cloud readiness ${run.id} attempt ${run.run_attempt} lost its runner; re-ran its failed jobs.`);
  } catch (error) {
    // The other waiter may have won the same write, or GitHub has not
    // finished cancelling the attempt. Both resolve on the next poll.
    const latest = await api(`/repos/${repository}/actions/runs/${run.id}`);
    if (!trusted(latest, sha, run.id)) throw error;
    if (latest.run_attempt > run.run_attempt || latest.status !== "completed" || [409, 422].includes(error.status)) return "retrying";
    throw error;
  }
  return "retrying";
}

/** The canonical writes and evidence reads `retryRunnerLoss` needs. */
export function createRunnerLossRetry({ token, fetcher = fetch, log = console.log }) {
  const client = createGithubClient({ token, fetcher });
  const write = async path => {
    if (!/^\/repos\/paperclipai\/paperclip\/actions\/runs\/[1-9]\d*\/(cancel|rerun-failed-jobs)$/.test(path)) throw new Error("Invalid runner-loss retry path.");
    const response = await fetcher(`https://api.github.com${path}`, { method: "POST", redirect: "error",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw Object.assign(new Error(`Could not retry a lost readiness runner: HTTP ${response.status}.`), { status: response.status });
  };
  return ({ sha, failure, api }) => retryRunnerLoss({ sha, failure, api, log, cancel: write, rerunFailed: write,
    readAnnotations: job => client.paginate(`/repos/${repository}/check-runs/${job.id}/annotations?per_page=100`),
    readLog: job => client.text(`/repos/${repository}/actions/jobs/${job.id}/logs`) });
}
