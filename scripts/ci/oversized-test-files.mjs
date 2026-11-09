import path from "node:path";
import { fileURLToPath } from "node:url";
import { moduleDurationMs } from "./test-timing-reporter.mjs";

// One file over this budget caps how evenly a lane can shard: the scheduler
// cannot split a file. Warn so authors split it; never fail the run.
export const oversizedThresholdEnv = "PAPERCLIP_CI_OVERSIZED_TEST_FILE_SECONDS";
export const defaultOversizedThresholdSeconds = 180;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function oversizedThresholdMs(environment = process.env) {
  const raw = environment[oversizedThresholdEnv];
  const seconds = raw === undefined || raw === "" ? NaN : Number(raw);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : defaultOversizedThresholdSeconds) * 1000;
}

export function repoRelative(file, root = repoRoot) {
  return path.relative(root, file).split(path.sep).join("/");
}

// https://docs.github.com/actions/reference/workflow-commands-for-github-actions
const escapeData = value => String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
const escapeProperty = value => escapeData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");

const seconds = ms => `${Number((ms / 1000).toFixed(ms < 10_000 ? 2 : 0))}s`;

export function oversizedAnnotation(file, durationMs, thresholdMs) {
  return `::warning file=${escapeProperty(file)},title=${escapeProperty("Oversized test file")}::`
    + escapeData(`${file} took ${seconds(durationMs)}, over the ${seconds(thresholdMs)} per-file budget (${oversizedThresholdEnv}). `
      + "Shards cannot split a file, so this bounds lane wall-clock time. Consider splitting it.");
}

// Vitest reporter. Wired for GitHub Actions only; it prints and never throws.
export default class OversizedTestFileReporter {
  constructor({ environment = process.env, write = line => console.log(line), root = repoRoot } = {}) {
    this.thresholdMs = oversizedThresholdMs(environment);
    this.write = write;
    this.root = root;
  }

  onTestModuleEnd(module) {
    try {
      if (module.state() === "skipped") return;
      const durationMs = moduleDurationMs(module.diagnostic());
      if (durationMs === null || durationMs <= this.thresholdMs) return;
      this.write(oversizedAnnotation(repoRelative(module.moduleId, this.root), durationMs, this.thresholdMs));
    } catch {
      // A diagnostic reporter must not change a test result.
    }
  }
}
