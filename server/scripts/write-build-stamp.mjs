// Write the build stamp for the server.
//
// The server `build` script runs this after `tsc`. It writes the commit SHA
// into `dist/build-info.json`. The instrumentation module reads that stamp to
// report `service.version`, so the value tracks the true built commit.
//
// The build must not fail when the stamp cannot read a commit. A missing `git`
// or a checkout with no `.git` (a tarball build) writes no stamp and exits 0.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const serverDir = join(scriptDir, "..");
const distDir = join(serverDir, "dist");
const outFile = join(distDir, "build-info.json");

let commit = null;
try {
  commit =
    execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: serverDir,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim() || null;
} catch {
  commit = null;
}

if (!commit) {
  // No git commit is available. Write no stamp and let the build continue.
  console.log("[build-stamp] no git commit available; wrote no build stamp");
  process.exit(0);
}

mkdirSync(distDir, { recursive: true });
writeFileSync(outFile, `${JSON.stringify({ commit }, null, 2)}\n`);
console.log(`[build-stamp] wrote ${outFile} commit=${commit}`);
