import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, "..");
const ensureScriptPath = path.join(repoRoot, "scripts", "ensure-plugin-build-deps.mjs");

if (!fs.existsSync(ensureScriptPath)) {
  throw new Error(`Missing pre-test dependency script: ${ensureScriptPath}`);
}

const result = spawnSync(process.execPath, [ensureScriptPath], {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

if (result.status !== 0) {
  throw new Error(`Failed to prepare test dependency build outputs (exit ${result.status ?? "unknown"}).`);
}
