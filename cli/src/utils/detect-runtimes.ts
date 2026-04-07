import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type KnownRuntime = "claude_local" | "codex_local" | "cursor_local" | "gemini_local" | "opencode_local";

export interface DetectedRuntime {
  type: KnownRuntime;
  label: string;
  command: string;
  available: boolean;
  version?: string;
}

const RUNTIME_PROBES: Array<{ type: KnownRuntime; label: string; command: string; versionArgs: string[] }> = [
  { type: "claude_local", label: "Claude Code", command: "claude", versionArgs: ["--version"] },
  { type: "codex_local", label: "Codex (OpenAI)", command: "codex", versionArgs: ["--version"] },
  { type: "cursor_local", label: "Cursor", command: "cursor", versionArgs: ["--version"] },
  { type: "gemini_local", label: "Gemini CLI", command: "gemini", versionArgs: ["--version"] },
  { type: "opencode_local", label: "OpenCode", command: "opencode", versionArgs: ["--version"] },
];

async function probeRuntime(probe: typeof RUNTIME_PROBES[number]): Promise<DetectedRuntime> {
  try {
    const { stdout } = await execFileAsync(probe.command, probe.versionArgs, { timeout: 5000 });
    const version = stdout.trim().split(/\r?\n/)[0]?.slice(0, 80) ?? undefined;
    return { type: probe.type, label: probe.label, command: probe.command, available: true, version };
  } catch {
    return { type: probe.type, label: probe.label, command: probe.command, available: false };
  }
}

/**
 * Probes all known agent runtimes in parallel and returns results.
 * Safe to call at any time — failures are caught per-runtime.
 */
export async function detectRuntimes(): Promise<DetectedRuntime[]> {
  return Promise.all(RUNTIME_PROBES.map(probeRuntime));
}

/**
 * Returns only runtimes that are available on this machine.
 */
export async function detectAvailableRuntimes(): Promise<DetectedRuntime[]> {
  const all = await detectRuntimes();
  return all.filter((r) => r.available);
}
