import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export async function createMcpIsolationRoot(prefix: string): Promise<string> {
  const parent = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? os.tmpdir();
  await fs.mkdir(parent, { recursive: true });
  return fs.mkdtemp(path.join(parent, prefix));
}

export async function commandVersion(command: string): Promise<string | null> {
  try {
    const result = await runCommand(command, ["--version"], { timeoutMs: 5_000 });
    if (result.exitCode !== 0) return null;
    return `${result.stdout}${result.stderr}`.trim();
  } catch {
    return null;
  }
}

export async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);

    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") child.kill("SIGTERM");
      else process.kill(-child.pid!, "SIGTERM");
    }, options.timeoutMs ?? 15_000);
    timer.unref();

    child.once("exit", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, stdout, stderr, timedOut });
    });
  });
}

export async function writeClaudeMcpConfig(
  filePath: string,
  servers: Record<string, { command: string; args: string[] }>,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify({ mcpServers: servers }), "utf8");
}

export async function writeCodexMcpConfig(
  codexHome: string,
  servers: Record<string, { command: string; args: string[] }>,
): Promise<void> {
  const sections = Object.entries(servers).flatMap(([name, server]) => [
    `[mcp_servers.${JSON.stringify(name)}]`,
    `command = ${JSON.stringify(server.command)}`,
    `args = ${JSON.stringify(server.args)}`,
    "",
  ]);
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(path.join(codexHome, "config.toml"), sections.join("\n"), "utf8");
}
