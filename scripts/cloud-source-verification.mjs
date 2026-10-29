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

// Statuses that say "ask again", not "the answer is no". A release must not be
// blocked because GitHub returned a gateway error during a 45-minute poll.
const TRANSIENT_READ_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

// A rate-limited read also says "ask again", and GitHub reports both primary
// and secondary rate limits as 403. Only the headers separate that from a
// token that may not read Actions, which must still fail at once.
function rateLimited(response) {
  if (response.status !== 403) return false;
  const header = (name) => response.headers?.get?.(name) ?? null;
  return header("retry-after") !== null || header("x-ratelimit-remaining") === "0";
}

/** Milliseconds from a Retry-After header, when it carries a sane delay. */
function retryAfterMs(response, capMs) {
  const value = Number(response?.headers?.get?.("retry-after"));
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.min(value * 1_000, capMs);
}

/**
 * The GitHub Actions read used by the polling below, with transient transport
 * failures retried: network errors, the statuses above, rate-limited 403s, and
 * a body that fails while it is being read. Any other non-OK status throws on
 * the first response, because waiting out a wrong token only delays the news.
 *
 * `deadlineAt` bounds retries by the caller's own polling deadline, so a read
 * cannot extend the wait past the timeout it belongs to.
 */
export function createActionsReader({
  token, fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attempts = 4, backoffMs = 1_000, log = console.log,
  now = Date.now, deadlineAt = () => Infinity, maxRetryAfterMs = 60_000,
} = {}) {
  return async (path) => {
    for (let attempt = 1; ; attempt += 1) {
      // Retry only while both the attempt budget and the caller's deadline
      // leave room for the wait this attempt would cost.
      const waitMs = backoffMs * attempt;
      const retryable = attempt < attempts && now() + waitMs < deadlineAt();
      const pause = (response) => sleep(retryAfterMs(response, maxRetryAfterMs) ?? waitMs);
      let response;
      try {
        response = await fetchImpl(`https://api.github.com${path}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
          signal: AbortSignal.timeout(30_000), redirect: "error",
        });
      } catch (cause) {
        if (!retryable) throw new Error(`GitHub Actions read failed: ${cause.message}`);
        log(`GitHub Actions read failed (${cause.message}); retrying (${attempt}/${attempts - 1}).`);
        await pause();
        continue;
      }
      if (response.ok) {
        try {
          // A 200 whose body is truncated or undecodable is a transport
          // failure like any other, so it belongs inside the retry.
          return await response.json();
        } catch (cause) {
          if (!retryable) throw new Error(`GitHub Actions read failed: ${cause.message}`);
          log(`GitHub Actions read body failed (${cause.message}); retrying (${attempt}/${attempts - 1}).`);
          await pause();
          continue;
        }
      }
      if (!retryable || !(TRANSIENT_READ_STATUSES.has(response.status) || rateLimited(response))) {
        throw new Error(`GitHub Actions read failed (HTTP ${response.status}).`);
      }
      log(`GitHub Actions read failed (HTTP ${response.status}); retrying (${attempt}/${attempts - 1}).`);
      await pause(response);
    }
  };
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
    // One deadline for both layers: the reader stops retrying when the poll it
    // serves is out of time, instead of extending the wait past its timeout.
    const timeoutMs = 45 * 60_000;
    const deadline = Date.now() + timeoutMs;
    const api = createActionsReader({ token: process.env.GITHUB_TOKEN, deadlineAt: () => deadline });
    const proof = await waitForSourceVerification(process.argv[2], { api, timeoutMs });
    const message = `Source verification passed for ${proof.sha}: https://github.com/${repository}/actions/runs/${proof.runId}/attempts/${proof.attempt} (job ${proof.jobId}).`;
    console.log(message);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
