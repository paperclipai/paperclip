import { oversizedAnnotation, oversizedThresholdMs, repoRelative } from "./oversized-test-files.mjs";

// The spec file the scheduler places on a shard. A test declared in a shared
// helper (smoke-lab.shared.ts) has that helper as its location, so walk up to
// the enclosing file suite instead.
export function specFile(test) {
  for (let suite = test.parent; suite; suite = suite.parent) {
    if (suite.type === "file" && suite.location?.file) return suite.location.file;
  }
  return test.location.file;
}

// Playwright reporter. A spec's cost is the sum of its test results, which
// include hooks and fixtures. Wired for GitHub Actions only; it never fails a run.
export default class OversizedSpecReporter {
  constructor({ environment = process.env, write = line => console.log(line), root } = {}) {
    this.thresholdMs = oversizedThresholdMs(environment);
    this.write = write;
    this.root = root;
    this.totals = new Map();
  }

  printsToStdio() {
    return false;
  }

  onTestEnd(test, result) {
    if (result.status === "skipped" || !Number.isFinite(result.duration)) return;
    const file = specFile(test);
    this.totals.set(file, (this.totals.get(file) ?? 0) + result.duration);
  }

  onEnd() {
    try {
      for (const [file, durationMs] of [...this.totals].sort((a, b) => b[1] - a[1])) {
        if (durationMs <= this.thresholdMs) continue;
        this.write(oversizedAnnotation(repoRelative(file, this.root), durationMs, this.thresholdMs));
      }
    } catch {
      // A diagnostic reporter must not change a test result.
    }
  }
}
