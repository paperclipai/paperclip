import {
  execFileSync,
  type ExecFileSyncOptions,
  type ExecFileSyncOptionsWithStringEncoding,
} from "node:child_process";

export function execGitSync(
  args: string[],
  options: ExecFileSyncOptionsWithStringEncoding,
): string;
export function execGitSync(args: string[], options?: ExecFileSyncOptions): Buffer;
export function execGitSync(
  args: string[],
  options: ExecFileSyncOptions = {},
): string | Buffer {
  return execFileSync("git", args, {
    ...options,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      ...(options.env ?? {}),
    },
  });
}
