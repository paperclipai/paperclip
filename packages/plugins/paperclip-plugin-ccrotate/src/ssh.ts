import { spawn, type ChildProcess } from "node:child_process";
import type { CcrotateSshConfig } from "./types.js";

export interface SshSpawnOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  stdin?: string;
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface SshSpawnResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildRemoteShellLine(opts: {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}): string {
  const parts: string[] = [];
  if (opts.cwd) parts.push(`cd ${shellQuote(opts.cwd)} &&`);
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      parts.push(`${k}=${shellQuote(v)}`);
    }
  }
  parts.push(shellQuote(opts.command));
  for (const arg of opts.args ?? []) parts.push(shellQuote(arg));
  return parts.join(" ");
}

function buildSshArgs(ssh: CcrotateSshConfig, remoteCommand: string): string[] {
  const args = [
    "-i", ssh.identityFile,
    "-p", String(ssh.port),
    "-o", "BatchMode=yes",
    "-o", "ServerAliveInterval=30",
    "-o", `StrictHostKeyChecking=${ssh.strictHostKeyChecking ? "yes" : "no"}`,
  ];
  if (!ssh.strictHostKeyChecking) {
    args.push("-o", "UserKnownHostsFile=/dev/null");
  }
  args.push(`${ssh.user}@${ssh.host}`);
  args.push(remoteCommand);
  return args;
}

const SIGKILL_GRACE_MS = 250;

export async function runSshCommand(
  ssh: CcrotateSshConfig,
  opts: SshSpawnOptions,
): Promise<SshSpawnResult> {
  const remote = buildRemoteShellLine({
    command: opts.command,
    args: opts.args,
    env: opts.env,
    cwd: opts.cwd,
  });
  const sshArgs = buildSshArgs(ssh, remote);

  return await new Promise<SshSpawnResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;

    const child: ChildProcess = spawn("ssh", sshArgs, {
      stdio: [opts.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
    });

    const timer = opts.timeoutMs && opts.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          killTimer = setTimeout(() => child.kill("SIGKILL"), SIGKILL_GRACE_MS);
        }, opts.timeoutMs)
      : null;

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      opts.onStdout?.(text);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      opts.onStderr?.(text);
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        exitCode: timedOut ? null : code,
        signal: signal ?? null,
        timedOut,
        stdout,
        stderr,
      });
    });

    if (opts.stdin != null && child.stdin) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }
  });
}

export async function rsyncToRemote(
  ssh: CcrotateSshConfig,
  localPath: string,
  remotePath: string,
): Promise<void> {
  const sshCmd = [
    "ssh",
    "-i", shellQuote(ssh.identityFile),
    "-p", String(ssh.port),
    "-o", "BatchMode=yes",
    "-o", `StrictHostKeyChecking=${ssh.strictHostKeyChecking ? "yes" : "no"}`,
  ].join(" ");

  const args = [
    "-az",
    "--delete",
    "-e", sshCmd,
    `${localPath.replace(/\/?$/, "/")}`,
    `${ssh.user}@${ssh.host}:${remotePath.replace(/\/?$/, "/")}`,
  ];

  return await new Promise<void>((resolve, reject) => {
    let stderr = "";
    const child = spawn("rsync", args, { stdio: ["ignore", "ignore", "pipe"] });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`rsync exited with code ${code}: ${stderr.trim()}`));
    });
  });
}
