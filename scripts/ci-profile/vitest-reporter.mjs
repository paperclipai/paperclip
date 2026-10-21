import { recorder, relativeFile } from "./record.mjs";
import { experimental_getRunnerTask } from "vitest/node";

export default class CiProfileReporter {
  record = recorder("vitest");
  onTestRunStart() { this.record({ kind: "start" }); }
  onTestRunEnd() { this.record({ kind: "end" }); }
  onTestCaseResult(test) {
    const timing = test.diagnostic();
    if (!timing?.startTime) return;
    this.record({
      kind: "test", id: test.id, parent: test.module.id,
      name: test.fullName, file: relativeFile(test.module.moduleId),
      start: timing.startTime, duration: timing.duration,
      status: test.result().state, retries: timing.retryCount,
    });
  }
  onTestModuleEnd(module) {
    const timing = module.diagnostic();
    // ModuleDiagnostic has no startTime in Vitest 5. Use the worker's
    // timestamp, not the time the controller receives this reporter event.
    const start = experimental_getRunnerTask(module).result?.startTime;
    if (!start) return;
    this.record({
      kind: "file", id: module.id, name: relativeFile(module.moduleId),
      file: relativeFile(module.moduleId), start,
      duration: timing.duration, status: module.state(),
      collectMs: timing.collectDuration, setupMs: timing.setupDuration,
    });
  }
}
