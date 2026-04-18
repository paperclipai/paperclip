import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ToolResult } from "./paperclip-tools.js";

const execAsync = promisify(exec);

const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 10 * 1024 * 1024;

async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<ToolResult> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: Math.min(timeoutMs, MAX_TIMEOUT_MS),
      maxBuffer: MAX_BUFFER,
    });
    const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
    return { content: combined || "(no output)", isError: false };
  } catch (err: unknown) {
    const e = err as { killed?: boolean; signal?: string; stdout?: string; stderr?: string; message?: string };
    if (e.killed || e.signal === "SIGTERM") {
      return { content: `Command timed out after ${timeoutMs}ms`, isError: true };
    }
    const msg = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n");
    return { content: msg || "Command failed", isError: true };
  }
}

export async function executeShellTool(
  name: string,
  args: Record<string, unknown>,
  cwd: string,
): Promise<ToolResult> {
  const timeout = typeof args.timeout === "number" ? args.timeout : DEFAULT_TIMEOUT_MS;

  switch (name) {
    case "shell_exec":
      return runCommand(String(args.command), cwd, timeout);

    case "git_status":
      return runCommand("git status", cwd, timeout);

    case "git_diff": {
      const ref = args.ref ? String(args.ref) : "";
      return runCommand(`git diff ${ref}`.trim(), cwd, timeout);
    }

    case "git_commit": {
      const files = Array.isArray(args.files) ? args.files.map(String) : [];
      const message = String(args.message);
      if (files.length === 0) {
        return { content: "No files specified", isError: true };
      }
      const addCmd = `git add ${files.map((f) => JSON.stringify(f)).join(" ")}`;
      const commitCmd = `git commit -m ${JSON.stringify(message)}`;
      return runCommand(`${addCmd} && ${commitCmd}`, cwd, timeout);
    }

    case "git_log": {
      const count = typeof args.count === "number" ? args.count : 10;
      return runCommand(`git log --oneline -n ${count}`, cwd, timeout);
    }

    default:
      return { content: `Unknown shell tool: ${name}`, isError: true };
  }
}
