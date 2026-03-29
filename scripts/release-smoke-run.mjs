import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeReleaseSmokeArgs } from "./release-smoke-run-args.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, "..");
const playwrightCliPath = path.join(repoRoot, "node_modules", "@playwright", "test", "cli.js");
const playwrightConfigPath = path.join(repoRoot, "tests", "release-smoke", "playwright.config.ts");
const forwardedArgs = normalizeReleaseSmokeArgs(process.argv.slice(2));

const result = spawnSync(process.execPath, [
  playwrightCliPath,
  "test",
  "--config",
  playwrightConfigPath,
  ...forwardedArgs,
], {
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
