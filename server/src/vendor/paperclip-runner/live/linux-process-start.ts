import type { LinuxProcessStartOptions } from "@paperclipai/paperclip-runner";

export type { LinuxProcessStartOptions };

type LinuxProcessStartModule = Pick<
  typeof import("@paperclipai/paperclip-runner"),
  "readLinuxProcessStartedAt"
>;
const sourceUrl = new URL(
  "../../../../../packages/paperclip-runner/src/live/linux-process-start.ts",
  import.meta.url,
);
const linuxProcessStart = (await import(sourceUrl.href)) as LinuxProcessStartModule;

export const readLinuxProcessStartedAt = linuxProcessStart.readLinuxProcessStartedAt;
