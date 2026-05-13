import { execFile } from "node:child_process";

export interface GitRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GitRunner {
  run(
    cmd: string,
    args: string[],
    opts?: { cwd?: string; env?: Record<string, string> },
  ): Promise<GitRunResult>;
}

export const realGitRunner: GitRunner = {
  async run(cmd, args, opts) {
    return new Promise((resolve) => {
      execFile(cmd, args, {
        cwd: opts?.cwd,
        env: { ...process.env, ...(opts?.env ?? {}) },
        maxBuffer: 10 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        const exitCode =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "number"
            ? error.code
            : 0;
        resolve({ exitCode, stdout, stderr });
      });
    });
  },
};
