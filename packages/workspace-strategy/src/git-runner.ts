import { spawn } from "node:child_process";

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

type ChildProcessCloseEmitter = {
  on(event: "close", listener: (code: number | null) => void): void;
};

export const realGitRunner: GitRunner = {
  async run(cmd, args, opts) {
    return new Promise((resolve) => {
      const child = spawn(cmd, args, {
        cwd: opts?.cwd,
        env: { ...process.env, ...(opts?.env ?? {}) },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => {
        stdout += d.toString();
      });
      child.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      (child as unknown as ChildProcessCloseEmitter).on("close", (code) =>
        resolve({ exitCode: code ?? -1, stdout, stderr }),
      );
    });
  },
};
