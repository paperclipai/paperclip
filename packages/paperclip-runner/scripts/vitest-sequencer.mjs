import { BaseSequencer } from "vitest/node";

const longTransportFiles = new Set([
  "runnerd-codex-transport.test.ts",
  "runnerd-codex-transport-deadlines.test.ts",
  "runnerd-codex-transport-settlement.test.ts",
]);

export class RunnerSequencer extends BaseSequencer {
  async sort(files) {
    const sorted = await super.sort(files);
    const priority = [];
    const remaining = [];
    for (const file of sorted) {
      const name = file.moduleId.replaceAll("\\", "/").split("/").at(-1);
      (longTransportFiles.has(name) ? priority : remaining).push(file);
    }
    return [...priority, ...remaining];
  }
}
