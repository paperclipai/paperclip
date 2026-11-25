import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ciScriptsDir = path.dirname(fileURLToPath(import.meta.url));
export const PR_WORKFLOW_NAME = "PR";

export function resolveNightlyOnlySuitesPath({
  repoRoot = process.cwd(),
  env = process.env,
} = {}) {
  const override = env.PAPERCLIP_CI_NIGHTLY_SUITES_FILE?.trim();
  if (override) {
    return path.resolve(repoRoot, override);
  }
  return path.join(ciScriptsDir, "nightly-only-suites.json");
}

export function loadNightlyOnlySuites(manifestPath) {
  if (!existsSync(manifestPath)) {
    return new Set();
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to parse nightly-only suites manifest ${manifestPath}: ${error.message}`);
  }
  const entries = Array.isArray(parsed) ? parsed : parsed?.suites;
  if (!Array.isArray(entries)) {
    throw new Error(`Nightly-only suites manifest ${manifestPath} must contain a "suites" array.`);
  }
  const suites = new Set();
  for (const entry of entries) {
    const suitePath = typeof entry === "string" ? entry : entry?.path;
    if (typeof suitePath !== "string" || suitePath.trim() === "") {
      throw new Error(`Invalid entry in nightly-only suites manifest ${manifestPath}.`);
    }
    suites.add(suitePath.trim().split(path.sep).join("/"));
  }
  return suites;
}

export function isNightlyExclusionEnabled(env = process.env) {
  const fullOverride = env.PAPERCLIP_CI_FULL?.trim().toLowerCase();
  if (fullOverride === "1" || fullOverride === "true") {
    return false;
  }
  const excludeOverride = env.PAPERCLIP_CI_EXCLUDE_NIGHTLY?.trim().toLowerCase();
  if (excludeOverride === "0" || excludeOverride === "false") {
    return false;
  }
  if (excludeOverride === "1" || excludeOverride === "true") {
    return true;
  }
  return env.GITHUB_WORKFLOW === PR_WORKFLOW_NAME;
}

export function activeNightlySuitesForEnv({
  repoRoot = process.cwd(),
  env = process.env,
} = {}) {
  if (!isNightlyExclusionEnabled(env)) {
    return new Set();
  }
  return loadNightlyOnlySuites(resolveNightlyOnlySuitesPath({ repoRoot, env }));
}
