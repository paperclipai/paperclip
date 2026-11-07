import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolveStandardImageDigest } from "./standard-image-contract.mjs";

export async function reuseCanaryImage(sha, {
  resolve = source => resolveStandardImageDigest(source, fetch, { missing: "return-null" }),
  run = (command, args) => execFileSync(command, args, { stdio: "inherit" }),
} = {}) {
  assert.match(sha ?? "", /^[a-f0-9]{40}$/);
  const digest = await resolve(sha);
  if (digest === null) return false;
  assert.match(digest, /^sha256:[a-f0-9]{64}$/);
  const image = `ghcr.io/paperclipai/paperclip@${digest}`;
  await run("gh", ["attestation", "verify", `oci://${image}`,
    "--repo", "paperclipai/paperclip", "--bundle-from-oci",
    "--signer-workflow", "paperclipai/paperclip/.github/workflows/docker.yml",
    "--source-ref", "refs/heads/master", "--source-digest", sha,
    "--signer-digest", sha, "--deny-self-hosted-runners"]);
  await run("docker", ["buildx", "imagetools", "create", "-t",
    `ghcr.io/paperclipai/paperclip:sha-${sha.slice(0, 7)}`, image]);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const reused = await reuseCanaryImage(process.env.GITHUB_SHA);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `reused=${reused}\n`);
  const summary = reused
    ? "Reused the signed multi-platform master image. Skipped both image builds and the manifest merge."
    : "No full-SHA master image exists. Building both platforms for this canary.";
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}
