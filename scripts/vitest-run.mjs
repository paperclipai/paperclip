import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeVitestRunArgs } from "./vitest-run-args.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, "..");
const vitestCliPath = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");
const forwardedArgs = normalizeVitestRunArgs(process.argv.slice(2));

const result = spawnSync(process.execPath, [vitestCliPath, "run", ...forwardedArgs], {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

if (typeof result.status === "number") {
  process.exit(result.status);
}

process.exit(1);
