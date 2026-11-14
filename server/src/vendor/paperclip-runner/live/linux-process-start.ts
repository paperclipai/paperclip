/**
 * Source-mode leaf shim for Linux process-start identity.
 *
 * Keep this import narrow: the process identity probe runs during server
 * startup and must not cold-load the Runner's complete runtime barrel. The
 * server build replaces this emitted shim with the Runner's compiled live
 * tree, just like the neighboring live/index.ts boundary.
 */
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
