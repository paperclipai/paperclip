import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
const exec = promisify(execFile);
export const localTestWorkFolderRunner: CommandManagedRuntimeRunner = {
  async execute(input) {
    try {
      const { stdout, stderr } = await exec(input.command, input.args ?? [], { cwd: input.cwd,
        env: { ...process.env, ...input.env }, timeout: input.timeoutMs, maxBuffer: 32 * 1024 * 1024 });
      return { stdout, stderr, exitCode: 0, signal: null, timedOut: false };
    } catch (error) {
      const value = error as Error & { stdout?: string; stderr?: string };
      return { stdout: value.stdout ?? "", stderr: value.stderr ?? value.message, exitCode: 1, signal: null, timedOut: false };
    }
  },
};
