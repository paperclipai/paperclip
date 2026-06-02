#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(repoRoot, "scripts", "release-package-manifest.json");
const packages = JSON.parse(readFileSync(manifestPath, "utf8"));

for (const pkg of packages) {
  if (typeof pkg?.dir !== "string" || !pkg.dir.startsWith("packages/plugins/sandbox-providers/")) {
    continue;
  }

  const cwd = join(repoRoot, pkg.dir);
  console.log(`Building ${pkg.name ?? pkg.dir}`);

  run("npm", ["install", "--no-audit", "--no-fund"], cwd);
  run("npm", ["run", "build"], cwd);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
