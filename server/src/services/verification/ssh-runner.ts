import { execFile as execFileDefault, type ExecFileException } from "node:child_process";

export interface SshRunInput {
  host: string;
  user: string;
  keyPath: string;
  command: string;
  timeoutMs: number;
  execFile?: typeof execFileDefault;
}

export interface SshRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class SshTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`ssh command exceeded timeout of ${timeoutMs}ms`);
    this.name = "SshTimeoutError";
  }
}

/**
 * Runs a single command on a remote host via ssh. Uses BatchMode=yes so missing/unreadable keys
 * fail fast rather than prompting for a password. The caller is responsible for constructing a
 * safe `command` string — this helper does NOT shell-escape arguments.
 */
export function runSshCommand(input: SshRunInput): Promise<SshRunResult> {
  const execFile = input.execFile ?? execFileDefault;
  const connectTimeoutSec = Math.max(5, Math.floor(input.timeoutMs / 10_000));
  const args = [
    "-i", input.keyPath,
    "-o", "StrictHostKeyChecking=no",
    "-o", "BatchMode=yes",
    "-o", `ConnectTimeout=${connectTimeoutSec}`,
    `${input.user}@${input.host}`,
    input.command,
  ];
  return new Promise((resolve, reject) => {
    execFile(
      "ssh",
      args,
      { timeout: input.timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        const outStr = typeof stdout === "string" ? stdout : "";
        const errStr = typeof stderr === "string" ? stderr : "";
        if (err) {
          const e = err as ExecFileException;
          if (e.killed || e.signal === "SIGTERM") {
            reject(new SshTimeoutError(input.timeoutMs));
            return;
          }
          const code = typeof e.code === "number" ? e.code : 1;
          resolve({ stdout: outStr, stderr: errStr, exitCode: code });
          return;
        }
        resolve({ stdout: outStr, stderr: errStr, exitCode: 0 });
      },
    );
  });
}
