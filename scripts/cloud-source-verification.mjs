import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const repository = "paperclipai/paperclip";
const workflowPath = ".github/workflows/cloud-readiness.yml";
export const sourceVerificationJob = "Cloud source verified v1";

function assertSha(sha) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw new Error("A full lowercase source SHA is required.");
}

function trustedRun(run, sha, workflowId) {
  return run.workflow_id === workflowId && run.path === workflowPath &&
    run.repository?.full_name === repository && run.head_repository?.full_name === repository &&
    run.head_sha === sha && run.head_branch === "master" && run.event === "push" &&
    Number.isSafeInteger(run.id) && run.id > 0 &&
    Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0;
}

// Consume one versioned job, independent of image/migrator availability. A
// failed image build must not invalidate source checks that already passed.
export async function readSourceVerification(sha, api) {
  assertSha(sha);
  const workflow = await api(`/repos/${repository}/actions/workflows/cloud-readiness.yml`);
  if (workflow.path !== workflowPath || !Number.isSafeInteger(workflow.id) || workflow.id < 1) {
    throw new Error("Cloud readiness workflow identity does not match.");
  }
  const listing = await api(`/repos/${repository}/actions/workflows/${workflow.id}/runs?head_sha=${sha}&event=push&branch=master&per_page=100`);
  if (!Array.isArray(listing.workflow_runs) || !Number.isSafeInteger(listing.total_count) ||
      listing.total_count < 0 || listing.total_count > 100 || listing.workflow_runs.length !== listing.total_count) {
    throw new Error("Cloud readiness run listing is incomplete.");
  }
  const run = listing.workflow_runs.filter((candidate) => trustedRun(candidate, sha, workflow.id))
    .sort((a, b) => b.id - a.id)[0];
  if (!run) return undefined;

  // Attempt-specific jobs prevent an earlier successful attempt from blessing
  // a later rerun. Keep pagination even though today's matrix fits one page.
  const jobs = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await api(`/repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`);
    if (!Array.isArray(batch.jobs)) throw new Error("Cloud readiness job listing is malformed.");
    jobs.push(...batch.jobs);
    if (batch.jobs.length < 100) break;
    if (page === 10) throw new Error("Cloud readiness job listing is incomplete.");
  }
  const matches = jobs.filter((job) => job.name === sourceVerificationJob);
  if (matches.length > 1) throw new Error("Cloud source verification job is ambiguous.");
  const job = matches[0];
  if (job?.status === "completed" && job.conclusion === "success" &&
      job.head_sha === sha && job.run_id === run.id && job.run_attempt === run.run_attempt) {
    // Re-read the run after its jobs: a rerun that started during polling must
    // not let the previous attempt through. Changes are retried next poll.
    const current = await api(`/repos/${repository}/actions/runs/${run.id}`);
    if (!trustedRun(current, sha, workflow.id) || current.run_attempt !== run.run_attempt) return undefined;
    return { sha, runId: run.id, attempt: run.run_attempt, jobId: job.id };
  }
  if (job?.status === "completed" || run.status === "completed") {
    throw new Error(`Cloud source verification did not pass for ${sha} (run ${run.id}, attempt ${run.run_attempt}). Rerun Cloud readiness before retrying the release.`);
  }
  return undefined;
}

export async function waitForSourceVerification(sha, {
  api, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 45 * 60_000, intervalMs = 30_000, log = console.log,
} = {}) {
  assertSha(sha);
  const deadline = now() + timeoutMs;
  log(`Waiting for ${sourceVerificationJob} for ${sha}.`);
  while (now() < deadline) {
    const result = await readSourceVerification(sha, api);
    if (result) return result;
    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(intervalMs, remaining));
  }
  throw new Error(`Cloud source verification timed out for ${sha}. Rerun Cloud readiness before retrying the release.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN with Actions read access is required.");
    const api = async (path) => {
      const response = await fetch(`https://api.github.com${path}`, {
        headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
        signal: AbortSignal.timeout(30_000), redirect: "error",
      });
      if (!response.ok) throw new Error(`GitHub Actions read failed (HTTP ${response.status}).`);
      return response.json();
    };
    const proof = await waitForSourceVerification(process.argv[2], { api });
    const message = `Source verification passed for ${proof.sha}: https://github.com/${repository}/actions/runs/${proof.runId}/attempts/${proof.attempt} (job ${proof.jobId}).`;
    console.log(message);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
