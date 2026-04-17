import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CRITICAL_DIST_FILES = [
  "packages/db/dist/index.js",
  "packages/db/dist/client.js",
  "packages/db/dist/migrations",
  "packages/shared/dist/index.js",
  "server/dist/index.js",
];

let failed = false;

for (const file of CRITICAL_DIST_FILES) {
  const abs = resolve(ROOT, file);
  if (!existsSync(abs)) {
    console.error(`MISSING: ${file}`);
    failed = true;
  }
}

if (failed) {
  console.error(
    "\nBuild verification failed — critical dist artifacts are missing.\n" +
      "Run `pnpm build` from the repo root and check for compilation errors.",
  );
  process.exit(1);
}

console.log("Build verification passed — all critical dist artifacts present.");
