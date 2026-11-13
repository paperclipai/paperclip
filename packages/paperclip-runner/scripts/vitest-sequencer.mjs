import { BaseSequencer } from "vitest/node";

const slowFiles = [
  "runnerd-codex-transport.test.ts",
  "runnerd-codex-transport-settlement.test.ts",
  "cursor-cloud-runner-launch.test.ts",
  "runnerd-codex-transport-deadlines.test.ts",
  "opencode-server-driver.test.ts",
  "acpx-controller-recovery.test.ts",
  "runnerd-codex-transport-warm-attachment.test.ts",
  "runnerd-opencode-streaming-tools.test.ts",
  "live-session.test.ts",
  "runnerd-codex-transport-adoption.test.ts",
];

const priority = (file) => {
  const name = file.moduleId.replaceAll("\\", "/").split("/").at(-1);
  const index = slowFiles.indexOf(name);
  return index < 0 ? slowFiles.length : index;
};

export class RunnerSequencer extends BaseSequencer {
  async sort(files) {
    const sorted = await super.sort(files);
    return sorted.sort((a, b) => priority(a) - priority(b));
  }
}
