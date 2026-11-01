import path from "node:path";

// One bounded metadata record per server file. No test names, output, or secrets.
// The refresh job reads these as data from successful protected-master runs.
export const timingPrefix = "PAPERCLIP_TEST_TIMING ";

export function fileTiming(module, root = process.cwd()) {
  if (module.project.name !== "@paperclipai/server" || module.state() !== "passed") return null;
  const file = path.relative(root, module.moduleId).split(path.sep).join("/");
  if (!/^server\/(?:src|scripts)\/.+\.test\.[cm]?[jt]s$/.test(file)) return null;
  const timing = module.diagnostic();
  const phases = [timing.duration, timing.collectDuration, timing.setupDuration,
    timing.prepareDuration, timing.environmentSetupDuration];
  if (phases.some(value => !Number.isFinite(value) || value < 0)) return null;
  return { version: 1, file, durationMs: Math.ceil(phases.reduce((sum, value) => sum + value, 0)) };
}

export default class TestTimingReporter {
  onTestModuleEnd(module) {
    const record = fileTiming(module);
    if (record) console.log(timingPrefix + JSON.stringify(record));
  }
}
