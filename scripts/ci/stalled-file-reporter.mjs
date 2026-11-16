import path from "node:path";
import { fileURLToPath } from "node:url";

// A test file that stops making progress otherwise holds its CI job silently
// until the job's time limit cancels it. Turbo prints a task's output only
// when the task ends, so a cancelled job never names the stuck file (server
// shard 2/12 on 2026-11-16: five cancellations at 20m16s, no file named).
//
// This reporter watches every running file. When one starts no test, hook or
// result for the stall limit, it prints a GitHub error annotation naming the
// file and the step it was in, then ends the run with a failure, so the job
// fails minutes earlier with the file and step in its log.
export const stallEnvName = "PAPERCLIP_VITEST_FILE_STALL_MS";
// The slowest healthy server files ran about 5 minutes in total
// (issue-recovery-live-run-agent-census, 235-300 s in PR shards), and no
// single test or hook in a healthy run goes this long without progress.
export const defaultStallMs = 8 * 60_000;
// How long a cancelled run may take to stop before the process exits anyway.
export const exitGraceMs = 30_000;
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

export function stallLimitMs(env = process.env) {
  const configured = env[stallEnvName]?.trim();
  if (!configured) return defaultStallMs;
  const parsed = Number(configured);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${stallEnvName} must be a positive integer of milliseconds. Received "${configured}".`);
  }
  return parsed;
}

// Watching is for CI, where a stuck file costs a whole job; a local run can be
// stopped by hand. The variable turns it on anywhere, for example to reproduce.
export function stalledFileReporterEnabled(env = process.env) {
  return env.GITHUB_ACTIONS === "true" || Boolean(env[stallEnvName]?.trim());
}

function escapeData(value) {
  return String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function escapeProperty(value) {
  return escapeData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

export function stallAnnotation(entry, now) {
  const minutes = ((now - entry.progressAt) / 60_000).toFixed(1);
  const properties = [`file=${escapeProperty(entry.file)}`, `title=${escapeProperty("Test file stopped making progress")}`];
  return `::error ${properties.join(",")}::${escapeData(
    `${entry.file} made no progress for ${minutes} min while in: ${entry.step}. `
    + "The run was stopped so this job fails with the file's name instead of reaching its time limit.")}`;
}

export default class StalledFileReporter {
  constructor(options = {}) {
    this.limitMs = options.limitMs ?? stallLimitMs();
    this.now = options.now ?? Date.now;
    this.exit = options.exit ?? (code => process.exit(code));
    this.write = options.write ?? (line => process.stderr.write(`${line}\n`));
    this.root = options.root ?? repoRoot;
    this.graceMs = options.graceMs ?? exitGraceMs;
    this.intervalMs = options.intervalMs ?? Math.min(15_000, Math.max(250, Math.floor(this.limitMs / 4)));
    this.files = new Map();
    this.timer = null;
    this.stopped = false;
  }

  onInit(vitest) {
    this.vitest = vitest;
  }

  onTestRunStart() {
    this.stopped = false;
    if (this.timer) return;
    // The reporter runs in the main Vitest process, whose timers tests never
    // fake. The interval must not keep a finished run alive.
    this.timer = setInterval(() => this.check(), this.intervalMs);
    this.timer.unref?.();
  }

  progress(moduleId, step) {
    const entry = this.files.get(moduleId);
    if (!entry) return;
    entry.progressAt = this.now();
    entry.step = step;
  }

  // Queued fires before the file is imported, so a file that never finishes
  // loading (a top-level await or a blocking setup import) is watched too.
  onTestModuleQueued(testModule) {
    const file = path.relative(this.root, testModule.moduleId).split(path.sep).join("/");
    this.files.set(testModule.moduleId, { file, progressAt: this.now(), step: "loading the file" });
  }

  onTestModuleStart(testModule) {
    if (!this.files.has(testModule.moduleId)) this.onTestModuleQueued(testModule);
    this.progress(testModule.moduleId, "starting the file's tests");
  }

  onHookStart(hook) {
    const moduleId = hook.entity?.module?.moduleId ?? hook.entity?.moduleId;
    const owner = hook.entity?.fullName ?? hook.entity?.name;
    this.progress(moduleId, owner ? `${hook.name} of ${owner}` : hook.name);
  }

  onHookEnd(hook) {
    this.onHookStart({ ...hook, name: `after ${hook.name}` });
  }

  onTestCaseReady(testCase) {
    this.progress(testCase.module.moduleId, `test "${testCase.fullName}"`);
  }

  onTestCaseResult(testCase) {
    this.progress(testCase.module.moduleId, `after test "${testCase.fullName}"`);
  }

  onTestModuleEnd(testModule) {
    this.files.delete(testModule.moduleId);
  }

  onTestRunEnd() {
    this.files.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // A cancelled run can report its finished files as passed. It still failed:
    // exit once the other reporters have printed their summaries.
    if (this.stopped) setTimeout(() => this.exit(1), 1000);
  }

  check() {
    if (this.stopped) return;
    const now = this.now();
    const stalled = [...this.files.values()].filter(entry => now - entry.progressAt >= this.limitMs);
    if (stalled.length === 0) return;
    this.stopped = true;
    for (const entry of stalled) this.write(stallAnnotation(entry, now));
    const running = [...this.files.values()].map(entry => entry.file).sort();
    this.write(`[stalled-file-reporter] stopping the run; files still running: ${running.join(", ")}`);
    process.exitCode = 1;
    // A stalled worker may never answer a cancel, so exit after a grace period
    // either way. This timer is kept referenced on purpose.
    setTimeout(() => this.exit(1), this.graceMs);
    void Promise.resolve(this.vitest?.cancelCurrentRun("stalled-file")).catch(() => undefined);
  }
}
