import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeBuildInputsDigest } from "../packages/paperclip-runner/scripts/build-inputs.mjs";

export function macRuntimeInputsDigest(root) {
  const hash = createHash("sha256").update(computeBuildInputsDigest(root).digest);
  for (const file of [".github/workflows/macos-runner-runtime.yml", "scripts/macos-runner-runtime.mjs", "scripts/macos-runner-runtime-cache.mjs"]) {
    hash.update(`\0${file}\0`).update(readFileSync(resolve(root, file)));
  }
  return `sha256:${hash.digest("hex")}`;
}

const REQUIRED_VERIFIED_JOB_NAMES = [
  "macos_runner_runtime / build",
  "macos_runner_runtime / verify_linux_controller",
];

export function isTrustedMacRuntimeWorkflowRun(run, repository) {
  return run?.repository?.full_name === repository && run.path === ".github/workflows/docker.yml"
    && run.event === "push" && run.head_branch === "master"
    && /^[a-f0-9]{40}$/.test(run.head_sha ?? "");
}

export function isTrustedMacRuntimeProducer(run, repository) {
  return isTrustedMacRuntimeWorkflowRun(run, repository) && run.conclusion === "success";
}

export function hasVerifiedMacRuntimeJobs(jobs) {
  if (!Array.isArray(jobs)) return false;
  return REQUIRED_VERIFIED_JOB_NAMES.every(name =>
    jobs.some(job => job?.name === name && job.status === "completed" && job.conclusion === "success"),
  );
}

export async function findMacRuntimeArtifact({ digest, repository, token, fetchImpl = fetch }) {
  if (!token || repository !== "paperclipai/paperclip") return null;
  const name = `macos-runner-runtime-${digest.slice(7)}`;
  const get = async path => {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
      redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw Error(`Runtime artifact lookup failed: ${response.status}`);
    return response.json();
  };
  const result = await get(`actions/artifacts?name=${name}&per_page=20`);
  for (const artifact of (result.artifacts ?? []).filter(item => item.name === name && !item.expired).slice(0, 10)) {
    if (!Number.isSafeInteger(artifact.workflow_run?.id) || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? "")) continue;
    const run = await get(`actions/runs/${artifact.workflow_run.id}`);
    if (!isTrustedMacRuntimeWorkflowRun(run, repository)) continue;
    if (run.conclusion === "success") return { runId: run.id, name };
    const jobsResult = await get(`actions/runs/${artifact.workflow_run.id}/jobs?per_page=100`);
    if (hasVerifiedMacRuntimeJobs(jobsResult?.jobs)) return { runId: run.id, name };
  }
  return null;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const digest = macRuntimeInputsDigest(root);
  const name = `macos-runner-runtime-${digest.slice(7)}`;
  let cached;
  try { cached = await findMacRuntimeArtifact({ digest, repository: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN }); }
  catch { process.stderr.write("No verified runtime artifact could be reused; building it from source.\n"); }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `digest=${digest}\nartifact_name=${name}\nrun_id=${cached?.runId ?? ""}\n`);
  console.log(JSON.stringify({ digest, artifactName: name, reusedFromRun: cached?.runId ?? null }));
}
