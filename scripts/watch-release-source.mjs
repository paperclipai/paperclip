import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createActionsReader, readSourceVerification, SourceVerificationFailed, SourceVerificationDeferred } from "./cloud-source-verification.mjs";
import { requestDeferredProducer, readMigratorPublication, sourceAdmissionJob, migratorAdmissionJob, createReleaseRerunner } from "./cloud-release-admission.mjs";

const repository = "paperclipai/paperclip";

export function runnerWaits(jobs, now = Date.now()) {
  return jobs.filter(job => ["queued", "in_progress", "completed"].includes(job.status) &&
    job.conclusion !== "skipped" && job.labels?.length > 0).map(job => ({
    job: job.name, id: job.id,
    seconds: Math.max(0, Math.floor(((job.runner_id > 0 && job.started_at ? Date.parse(job.started_at) : now) - Date.parse(job.created_at)) / 1000)),
  })).filter(job => Number.isFinite(job.seconds));
}

// The write is limited to this canonical master Docker run. Never cancel
// another workflow, a tag release, or a run selected from untrusted input.
export async function cancelImageRun({ api, cancel, runId, attempt, sha }) {
  const run = await api(`/repos/${repository}/actions/runs/${runId}`);
  if (run.id !== runId || run.run_attempt !== attempt || run.head_sha !== sha || run.head_branch !== "master" ||
      run.repository?.id !== 1170821064 || run.head_repository?.id !== 1170821064 ||
      run.path !== ".github/workflows/docker.yml" || !["push", "workflow_dispatch"].includes(run.event)) {
    throw new Error("Refusing to cancel a different image workflow identity.");
  }
  if (run.status !== "completed") await cancel(`/repos/${repository}/actions/runs/${runId}/cancel`);
}

async function cancelFailedVerification({ api, cancel, sha }, failure) {
  const run = await api(`/repos/${repository}/actions/runs/${failure.runId}`);
  // A concurrent retry owns the new attempt; a late observer leaves it alone.
  if (run.run_attempt !== failure.attempt) return;
  if (run.id !== failure.runId || run.head_sha !== sha || run.head_branch !== "master" || run.event !== "push" ||
      run.repository?.full_name !== repository || run.head_repository?.full_name !== repository ||
      run.path !== ".github/workflows/cloud-readiness.yml") throw new Error("Failed verification identity changed.");
  if (run.status !== "completed") await cancel(`/repos/${repository}/actions/runs/${failure.runId}/cancel`);
}

export async function watchReleaseSource({ sha, runId, attempt, api, cancel, rerun, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), log = console.log,
  timeoutMs = 40 * 60_000, intervalMs = 30_000, requireProof = false, summary = async () => {} }) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? "") || !Number.isSafeInteger(runId) || runId < 1 ||
      !Number.isSafeInteger(attempt) || attempt < 1) throw new Error("Invalid release identity.");
  const deadline = now() + timeoutMs;
  const warned = new Set();
  const requested = new Set();
  const reportWaits = async jobs => {
    for (const wait of runnerWaits(jobs, now())) {
      if (wait.seconds > 60 && !warned.has(wait.id)) {
        warned.add(wait.id);
        log(`::warning title=Release runner waited over 60 seconds::Job ${wait.id} waited ${wait.seconds}s for a runner.`);
        await summary(`Release runner wait: ${wait.job} — ${wait.seconds}s (job ${wait.id}).\n`);
      }
    }
  };
  while (now() < deadline) {
    // Keep observing until publication, even after a build appeared admitted.
    // GitHub may transiently label a job in progress before skipping it.
    if (rerun) await requestDeferredProducer({ file: "cloud-migrator-artifacts.yml", sha, admissionJob: migratorAdmissionJob, api, rerun, requested });
    const batch = await api(`/repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`);
    if (!Array.isArray(batch.jobs) || batch.total_count > 100) throw new Error("Incomplete image job listing.");
    await reportWaits(batch.jobs);
    try {
      const proof = await readSourceVerification(sha, api, { failFast: true, onJobs: reportWaits });
      if (proof && (!rerun || await readMigratorPublication(sha, api))) {
        await summary(`Exact source verified: ${sha}; readiness run ${proof.runId}, attempt ${proof.attempt}.\n`);
        return proof;
      }
    } catch (error) {
      if (error instanceof SourceVerificationDeferred && rerun) {
        await requestDeferredProducer({ file: "cloud-readiness.yml", sha, admissionJob: sourceAdmissionJob, api, rerun, requested });
      } else {
        if (error instanceof SourceVerificationFailed) {
          await cancelFailedVerification({ api, cancel, sha }, error);
          await cancelImageRun({ api, cancel, runId, attempt, sha });
        }
        throw error;
      }
    }
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
  // This early failure observer is not the publication deadline. Healthy
  // checks can outlive a Spot worker; a separate exact-source gate still
  // waits for proof before publishing any image.
  if (requireProof) throw new Error("Exact-source verification and migrator publication did not become ready before the publication deadline.");
  await summary("Source monitoring window ended; final publication still requires exact-source verification and migrator publication.\n");
  return undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.GITHUB_TOKEN;
  if (!token || process.env.GITHUB_REPOSITORY !== repository || process.env.GITHUB_REF !== "refs/heads/master") throw new Error("Canonical master token required.");
  const requireProof = process.argv.includes("--require-proof");
  const checkProof = process.argv.includes("--check-proof");
  const api = createActionsReader({ token });
  const proof = checkProof ? await readSourceVerification(process.env.GITHUB_SHA, api, { failFast: true }) : await watchReleaseSource({ requireProof, sha: process.env.GITHUB_SHA, runId: Number(process.env.GITHUB_RUN_ID), attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    api,
    rerun: createReleaseRerunner(token),
    cancel: async path => {
      const response = await fetch(`https://api.github.com${path}`, { method: "POST", redirect: "error",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Could not cancel failed-source image work: HTTP ${response.status}.`);
    },
    summary: text => process.env.GITHUB_STEP_SUMMARY ? appendFile(process.env.GITHUB_STEP_SUMMARY, text) : Promise.resolve(),
  });
  if (checkProof && !proof) throw new Error("Exact-source proof changed before publication.");
  if (checkProof && !await readMigratorPublication(process.env.GITHUB_SHA, api)) throw new Error("Exact-source migrator has not published.");
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `verified=${Boolean(proof)}\n`);
}
