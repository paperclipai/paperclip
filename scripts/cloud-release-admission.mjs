import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createActionsReader } from "./github-actions-reader.mjs";

const repository = "paperclipai/paperclip";
const repositoryId = 1170821064;
const workflows = new Set(["docker.yml", "release.yml", "cloud-readiness.yml", "cloud-migrator-artifacts.yml"]);
export const sourceAdmissionJob = "Cloud candidate admission v1";
export const migratorAdmissionJob = "Cloud image candidate admission v1";

function assertSha(sha) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw new Error("Admission requires a full source SHA.");
}

function trusted(run, sha, workflow) {
  return run.workflow_id === workflow.id && run.path === workflow.path && run.head_sha === sha &&
    run.repository?.id === repositoryId && run.head_repository?.id === repositoryId &&
    run.repository?.full_name === repository && run.head_repository?.full_name === repository &&
    run.head_branch === "master" && run.event === "push" &&
    Number.isSafeInteger(run.id) && run.id > 0 && Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0;
}

async function producer(file, sha, api, status) {
  assertSha(sha);
  if (!workflows.has(file)) throw new Error("Unknown release workflow.");
  const workflow = await api(`/repos/${repository}/actions/workflows/${file}`);
  if (workflow.path !== `.github/workflows/${file}` || !Number.isSafeInteger(workflow.id) || workflow.id < 1) throw new Error("Release workflow identity mismatch.");
  const list = await api(`/repos/${repository}/actions/workflows/${workflow.id}/runs?branch=master&event=push&head_sha=${sha}&per_page=100${status ? `&status=${status}` : ""}`);
  if (!Array.isArray(list.workflow_runs) || !Number.isSafeInteger(list.total_count) || list.total_count < 0 ||
      list.total_count > 100 || list.workflow_runs.length !== list.total_count) throw new Error("Incomplete release workflow listing.");
  const run = list.workflow_runs.filter(run => trusted(run, sha, workflow) && (!status || run.status === status)).sort((a, b) => b.id - a.id)[0];
  return { workflow, run };
}

// A retry is an explicit request for this exact immutable source. Normal push
// work starts only for a candidate admitted by an image build or npm canary.
export async function releaseAdmitted(sha, { api, event = "push", attempt = 1, imageOnly = false }) {
  assertSha(sha);
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("Invalid release attempt.");
  if (!["push", "workflow_dispatch"].includes(event)) return false;
  if (event === "workflow_dispatch" || (Number.isSafeInteger(attempt) && attempt > 1)) return true;
  for (const file of imageOnly ? ["docker.yml"] : ["docker.yml", "release.yml"]) {
    const { workflow, run } = await producer(file, sha, api, "in_progress");
    if (!run) continue;
    const current = await api(`/repos/${repository}/actions/runs/${run.id}`);
    if (current.id === run.id && trusted(current, sha, workflow) && current.run_attempt === run.run_attempt && current.status === "in_progress") return true;
  }
  return false;
}

export function deferredProducer(jobs, run, admissionJob) {
  const admission = jobs.filter(job => job.name === admissionJob);
  const remaining = jobs.filter(job => job.name !== admissionJob);
  return run.status === "completed" && run.conclusion === "success" && admission.length === 1 && admission[0].status === "completed" && admission[0].conclusion === "success" && remaining.length > 0 &&
    remaining.every(job => job.status === "completed" && job.conclusion === "skipped") &&
    jobs.every(job => job.run_id === run.id && job.run_attempt === run.run_attempt && job.head_sha === run.head_sha);
}

async function producerJobs(run, api) {
  const jobs = [];
  let total;
  for (let page = 1; page <= 10; page++) {
    const batch = await api(`/repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`);
    if (!Array.isArray(batch.jobs) || !Number.isSafeInteger(batch.total_count) || batch.total_count < 0) throw new Error("Invalid release producer job list.");
    if ((total !== undefined && total !== batch.total_count) ||
        batch.jobs.length !== Math.min(100, Math.max(0, batch.total_count - (page - 1) * 100))) throw new Error("Incomplete release producer job list.");
    total = batch.total_count;
    jobs.push(...batch.jobs);
    if (page * 100 >= total) return jobs;
  }
  throw new Error("Incomplete release producer job list.");
}

/** Admission is not publication. The final image gate requires the exact
 * canonical migrator publisher, including a fresh read after its job evidence. */
export async function readMigratorPublication(sha, api) {
  const { workflow, run } = await producer("cloud-migrator-artifacts.yml", sha, api);
  if (!run) return false;
  const current = await api(`/repos/${repository}/actions/runs/${run.id}`);
  if (current.id !== run.id || !trusted(current, sha, workflow) || current.run_attempt !== run.run_attempt || current.status !== "completed") return false;
  if (current.conclusion !== "success") throw new Error("Exact-source migrator publication failed; inspect its workflow before retrying.");
  const jobs = await producerJobs(current, api);
  if (!jobs.every(job => job.run_id === run.id && job.run_attempt === current.run_attempt && job.head_sha === sha)) return false;
  const publish = jobs.filter(job => job.name === "publish");
  if (publish.length !== 1 || publish[0].status !== "completed" || publish[0].conclusion !== "success") return false;
  const confirmed = await api(`/repos/${repository}/actions/runs/${run.id}`);
  return confirmed.id === run.id && trusted(confirmed, sha, workflow) && confirmed.run_attempt === current.run_attempt &&
    confirmed.status === "completed" && confirmed.conclusion === "success";
}

// Only skipped admission is restartable here. A failed check or build never
// becomes an automatic retry, and every write revalidates canonical identity.
export async function requestDeferredProducer({ file, sha, admissionJob, api, rerun, requested = new Set() }) {
  if (({ "cloud-readiness.yml": sourceAdmissionJob, "cloud-migrator-artifacts.yml": migratorAdmissionJob })[file] !== admissionJob) throw new Error("Unknown deferred producer contract.");
  const { workflow, run } = await producer(file, sha, api);
  if (!run) return "pending";
  const key = `${run.id}/${run.run_attempt}`;
  if (requested.has(key)) return "pending";
  const jobs = await producerJobs(run, api);
  if (run.status !== "completed") {
    const current = jobs.filter(job => job.run_id === run.id && job.run_attempt === run.run_attempt && job.head_sha === sha);
    // Admission itself succeeds for both outcomes. Only an actual build is
    // evidence that its output admitted work; queued jobs may still be skipped.
    return current.some(job => job.name !== admissionJob && Number.isSafeInteger(job.runner_id) && job.runner_id > 0 &&
      ["in_progress", "completed"].includes(job.status) && job.conclusion !== "skipped")
      ? "admitted" : "pending";
  }
  if (!deferredProducer(jobs, run, admissionJob)) return "finished";
  const current = await api(`/repos/${repository}/actions/runs/${run.id}`);
  if (current.id !== run.id || !trusted(current, sha, workflow) || current.run_attempt !== run.run_attempt || current.status !== "completed" || current.conclusion !== "success") return "pending";
  try {
    await rerun(`/repos/${repository}/actions/runs/${run.id}/rerun`);
  } catch (error) {
    // Docker and npm may select the same source at the same time. A rejected
    // duplicate write is harmless only when a fresh read proves a retry began.
    const latest = await api(`/repos/${repository}/actions/runs/${run.id}`);
    if (latest.id !== run.id || !trusted(latest, sha, workflow)) throw error;
    if (!(latest.run_attempt > run.run_attempt || (latest.run_attempt === run.run_attempt &&
      ["queued", "in_progress", "requested", "pending", "waiting"].includes(latest.status)))) {
      // GitHub may reject a duplicate before its read API shows the retry.
      // Leave it pending for the next poll; this is not proof of admission.
      if ([409, 422].includes(error.status) && latest.run_attempt === run.run_attempt && latest.status === "completed" && latest.conclusion === "success") return "pending";
      throw error;
    }
  }
  requested.add(key);
  return "pending";
}

export function createReleaseRerunner(token, fetchImpl = fetch) {
  return async path => {
    if (!/^\/repos\/paperclipai\/paperclip\/actions\/runs\/[1-9]\d*\/rerun$/.test(path)) throw new Error("Invalid release retry path.");
    const response = await fetchImpl(`https://api.github.com${path}`, { method: "POST", redirect: "error",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw Object.assign(new Error(`Could not admit deferred release work: HTTP ${response.status}.`), { status: response.status });
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.GITHUB_REPOSITORY !== repository || process.env.GITHUB_REF !== "refs/heads/master" || !process.env.GITHUB_TOKEN) throw new Error("Canonical master admission context required.");
  const admitted = await releaseAdmitted(process.env.GITHUB_SHA, { api: createActionsReader({ token: process.env.GITHUB_TOKEN }),
    event: process.env.GITHUB_EVENT_NAME, attempt: Number(process.env.GITHUB_RUN_ATTEMPT), imageOnly: process.argv[2] === "image-only" });
  console.log(admitted ? "Release candidate admitted." : "Full build deferred until a release consumer admits this source.");
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `admitted=${admitted}\n`);
}
