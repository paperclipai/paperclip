#!/usr/bin/env node
/**
 * deploy-live.mjs -- ship master to the serving tree. (LOOA-382)
 *
 * The old deploy contract was implicit: "merge to master IS deploy", because
 * the server watched the tree you merged into. That coupling is exactly what
 * made a *save* a deploy and a *checkout* a deploy. Once the server runs from
 * its own checkout, deploying becomes a thing you say rather than a side effect
 * of where you happened to be standing:
 *
 *     merge to master   (in the integration tree -- reviewed, committed)
 *     pnpm deploy:live  (fast-forwards the serving tree; tsx watch picks it up)
 *
 * The serving tree only ever fast-forwards, so it is by construction always at
 * a committed master. There is no state it can be in that master was not.
 *
 * Usage:
 *   pnpm deploy:live
 *   pnpm deploy:live --dry-run
 */

import { execFileSync } from "node:child_process";
import process from "node:process";

import { resolveLiveTree } from "./live-service.mjs";

const dryRun = process.argv.includes("--dry-run");
const HEALTH_TIMEOUT_MS = 120_000;

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

async function waitForHealth(url) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
      const body = await response.json();
      // Health cannot tell you *which* instance a server attached to (an empty
      // one answers identically). Here that is fine -- deploy only ever
      // fast-forwards a server that is already serving the live instance, so
      // the only question is whether it survived the reload.
      if (body?.status === "ok") return true;
    } catch {
      // The server is mid-reload. That is the expected state here, not an error.
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}

const { tree: liveTree, source, service } = resolveLiveTree();

if (source !== "service-registry") {
  console.error(
    `No control plane is running, so there is nothing to deploy to.\n` +
      `Start it from the serving tree first:  cd <serving-tree> && pnpm dev`,
  );
  process.exit(1);
}

const mainWorktree = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], process.cwd());
const servingIsThisRepo = (() => {
  try {
    return git(["rev-parse", "--path-format=absolute", "--git-common-dir"], liveTree) === mainWorktree;
  } catch {
    return false;
  }
})();

if (servingIsThisRepo) {
  console.error(
    `The control plane is serving from ${liveTree}, which is this repository's own\n` +
      `worktree -- the pre-LOOA-382 topology, where merging to master IS the deploy.\n` +
      `There is nothing for deploy:live to fast-forward. Run the cutover first:\n\n` +
      `    scripts/cutover-live.sh --dry-run\n`,
  );
  process.exit(1);
}

console.log(`serving tree: ${liveTree}  (pid ${service.pid}, ${service.url})`);

const before = git(["rev-parse", "HEAD"], liveTree);
git(["fetch", "origin", "master"], liveTree);
const target = git(["rev-parse", "origin/master"], liveTree);

if (before === target) {
  console.log(`already at ${target.slice(0, 9)} -- nothing to deploy`);
  process.exit(0);
}

const dirty = git(["status", "--porcelain"], liveTree);
if (dirty) {
  console.error(
    `The serving tree has uncommitted changes. It is production and nobody should\n` +
      `ever have been in it. Investigate before deploying:\n\n${dirty}\n`,
  );
  process.exit(1);
}

const log = git(["log", "--oneline", `${before}..${target}`], liveTree);
console.log(`deploying ${before.slice(0, 9)} -> ${target.slice(0, 9)}:\n${log}\n`);

// A lockfile change means the new code may import a dependency the running
// install does not have. tsx watch reloads the instant the files land, so there
// is a window where the server is running new code against old node_modules.
// This is not new -- merging a lockfile change into the live tree has always had
// it -- but say so out loud rather than letting it look like a random crash.
const lockChanged = git(["diff", "--name-only", before, target, "--", "pnpm-lock.yaml"], liveTree);

if (dryRun) {
  console.log(`dry run: would fast-forward${lockChanged ? " and run pnpm install (lockfile changed)" : ""}.`);
  process.exit(0);
}

git(["merge", "--ff-only", "origin/master"], liveTree);
console.log(`fast-forwarded to ${target.slice(0, 9)}`);

if (lockChanged) {
  console.log("lockfile changed -- installing dependencies (the server will be unhealthy until this finishes)");
  run("pnpm", ["install", "--frozen-lockfile"], liveTree);
}

console.log("waiting for the server to come back...");
if (await waitForHealth(`${service.url}/api/health`)) {
  console.log(`deployed: ${liveTree} is serving ${target.slice(0, 9)}`);
  process.exit(0);
}

console.error(
  `The server did not return to health after the deploy.\n` +
    `Roll back with:\n\n    git -C ${liveTree} reset --hard ${before}\n`,
);
process.exit(1);
