// Write the build stamp for the server.
//
// The server `build` script runs this after `tsc`. It writes the commit SHA
// into `dist/build-info.json`. The instrumentation module reads that stamp to
// report `service.version`, so the value tracks the true built commit.
//
// The build resolves the commit in two steps:
//   1. `git rev-parse --short HEAD` in the server directory.
//   2. The `PAPERCLIP_BUILD_COMMIT` environment variable.
// A Docker image build excludes `.git`, so the git lookup fails there. The
// image build passes the commit in `PAPERCLIP_BUILD_COMMIT` instead, so the
// stamp still records the true built commit.
//
// The build must not fail when no commit is available. A missing `git`, a
// checkout with no `.git`, and an unset `PAPERCLIP_BUILD_COMMIT` together write
// no stamp and exit 0.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const serverDir = join(scriptDir, "..");
const distDir = join(serverDir, "dist");
const outFile = join(distDir, "build-info.json");

/**
 * Resolve the commit for the build stamp. Prefer the git commit. Fall back to
 * the supplied commit — the value a Docker image build passes in
 * `PAPERCLIP_BUILD_COMMIT` when `.git` is absent. Return null when neither
 * source gives a non-empty value.
 *
 * @param {unknown} gitCommit The `git rev-parse` result, or null on failure.
 * @param {unknown} suppliedCommit The `PAPERCLIP_BUILD_COMMIT` value.
 * @returns {string | null}
 */
export function resolveBuildCommit(gitCommit, suppliedCommit) {
  const git = typeof gitCommit === "string" ? gitCommit.trim() : "";
  if (git) return git;
  const supplied = typeof suppliedCommit === "string" ? suppliedCommit.trim() : "";
  if (supplied) return supplied;
  return null;
}

/**
 * Read the short commit SHA with `git rev-parse --short HEAD` in the server
 * directory. Return the SHA, or null on any failure.
 *
 * @returns {string | null}
 */
function readGitCommit() {
  try {
    const out = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: serverDir,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the commit and write the build stamp. Write no stamp and return when
 * no commit is available, so the build continues.
 */
function main() {
  const commit = resolveBuildCommit(readGitCommit(), process.env.PAPERCLIP_BUILD_COMMIT);

  if (!commit) {
    console.log("[build-stamp] no commit available; wrote no build stamp");
    return;
  }

  mkdirSync(distDir, { recursive: true });
  writeFileSync(outFile, `${JSON.stringify({ commit }, null, 2)}\n`);
  console.log(`[build-stamp] wrote ${outFile} commit=${commit}`);
}

// Run only when node invokes this file directly (the `build` script). A test
// that imports `resolveBuildCommit` does not run `main`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
