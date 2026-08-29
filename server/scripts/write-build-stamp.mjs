// Write the immutable commit stamp consumed by the running server.
//
// Docker builds do not include .git, so the build workflow supplies the full
// source SHA through PAPERCLIP_BUILD_COMMIT. Local builds use the checkout's
// HEAD. A missing source SHA is allowed for ordinary local development; the
// runtime then falls back to its normal git/package metadata.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const scriptDir = dirname(fileURLToPath(import.meta.url));
const serverDir = join(scriptDir, "..");
const distDir = join(serverDir, "dist");
const outFile = join(distDir, "build-info.json");

export function normalizeBuildCommit(value) {
  const commit = typeof value === "string" ? value.trim() : "";
  return FULL_SHA_RE.test(commit) ? commit.toLowerCase() : null;
}

export function resolveBuildCommit(gitCommit, suppliedCommit) {
  return normalizeBuildCommit(gitCommit) ?? normalizeBuildCommit(suppliedCommit);
}

function readGitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: serverDir,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
  } catch {
    return null;
  }
}

function main() {
  const commit = resolveBuildCommit(readGitCommit(), process.env.PAPERCLIP_BUILD_COMMIT);
  if (!commit) {
    console.log("[build-stamp] no full commit available; wrote no build stamp");
    return;
  }

  mkdirSync(distDir, { recursive: true });
  writeFileSync(outFile, `${JSON.stringify({ commit }, null, 2)}\n`);
  console.log(`[build-stamp] wrote ${outFile} commit=${commit}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
