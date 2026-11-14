import type { LinuxProcessStartOptions } from "@paperclipai/paperclip-runner";

type LinuxProcessStartModule = {
  readLinuxProcessStartedAt: (pid: number, options?: LinuxProcessStartOptions) => string;
};

const sourceUrl = new URL(
  "../../../../../packages/paperclip-runner/src/live/linux-process-start.ts",
  import.meta.url,
);
const runner = (await import(sourceUrl.href)) as LinuxProcessStartModule;

export const readLinuxProcessStartedAt = runner.readLinuxProcessStartedAt;
