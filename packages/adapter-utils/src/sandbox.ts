// Filesystem sandbox for agent processes using bubblewrap (bwrap).
//
// Prevents agents from reading other agents' workspaces, the master encryption
// key, the embedded database, and other sensitive instance-level paths.
//
// Security model:
//   1. Mount the entire host FS read-only as the base layer.
//   2. Replace sensitive instance directories (secrets, db, all workspaces) with
//      empty tmpfs mounts so the originals are invisible.
//   3. Re-mount the agent's own workspace and working directory read-write.
//   4. Fresh /proc (PID namespace) hides other processes' /proc/[pid]/environ.
//   5. Private /tmp per sandbox.

import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SandboxConfig {
  /** Enable/disable sandboxing. When false, command runs unsandboxed. */
  enabled: boolean;
  /** Paperclip instance root (e.g. ~/.paperclip/instances/default). */
  instanceRoot: string;
  /** The agent's own workspace directory (gets rw mount). */
  agentWorkspace: string;
  /** The working directory for this run (gets rw mount). May differ from agentWorkspace. */
  cwd: string;
  /** Additional paths to mount read-write inside the sandbox. */
  additionalRwPaths?: string[];
  /** Additional paths to mount read-only inside the sandbox. */
  additionalRoPaths?: string[];
  /**
   * Behavior when bwrap is not available.
   * - "refuse": throw an error and prevent execution.
   * - "warn": log a warning and run unsandboxed.
   * Default: "warn"
   */
  fallback?: "refuse" | "warn";
}

export interface SandboxedCommand {
  command: string;
  args: string[];
}

// ---------------------------------------------------------------------------
// bwrap availability check (cached)
// ---------------------------------------------------------------------------

let bwrapAvailable: boolean | null = null;

export function checkBwrapAvailable(): boolean {
  if (bwrapAvailable !== null) return bwrapAvailable;
  try {
    execFileSync("bwrap", ["--version"], {
      stdio: "ignore",
      timeout: 5000,
    });
    bwrapAvailable = true;
  } catch {
    bwrapAvailable = false;
  }
  return bwrapAvailable;
}

/** Reset the cached availability check (for testing). */
export function resetBwrapCache(): void {
  bwrapAvailable = null;
}

// ---------------------------------------------------------------------------
// bwrap argument builder
// ---------------------------------------------------------------------------

/**
 * Build a bwrap-wrapped command that isolates the agent process.
 *
 * Returns the original command/args unchanged if sandboxing is disabled or
 * bwrap is unavailable (and fallback is "warn").
 *
 * @throws If sandbox is enabled, bwrap is missing, and fallback is "refuse".
 */
export function wrapWithSandbox(
  config: SandboxConfig,
  command: string,
  args: string[],
  opts?: {
    onWarn?: (message: string) => void;
  },
): SandboxedCommand {
  if (!config.enabled) {
    return { command, args };
  }

  const available = checkBwrapAvailable();
  if (!available) {
    const fallback = config.fallback ?? "warn";
    if (fallback === "refuse") {
      throw new Error(
        "Sandbox enabled but bwrap is not installed. " +
          "Install bubblewrap (apt install bubblewrap) or set sandbox to false.",
      );
    }
    opts?.onWarn?.(
      "Sandbox enabled but bwrap not found — running agent UNSANDBOXED. " +
        "Install bubblewrap for filesystem isolation.",
    );
    return { command, args };
  }

  const bwrapArgs = buildBwrapArgs(config, command, args);
  return { command: "bwrap", args: bwrapArgs };
}

function buildBwrapArgs(
  config: SandboxConfig,
  command: string,
  args: string[],
): string[] {
  const { instanceRoot, agentWorkspace, cwd } = config;
  const result: string[] = [];

  // 1. Base layer: entire host filesystem read-only
  result.push("--ro-bind", "/", "/");

  // 2. Fresh /proc — isolates PID namespace, hides other processes' environ
  result.push("--proc", "/proc");

  // 3. Minimal /dev
  result.push("--dev", "/dev");

  // 4. Private /tmp
  result.push("--tmpfs", "/tmp");

  // 5. Hide sensitive instance directories by overlaying with empty tmpfs.
  //    Order matters: these override the ro-bind of / above.
  result.push("--tmpfs", `${instanceRoot}/secrets`);
  result.push("--tmpfs", `${instanceRoot}/db`);
  result.push("--tmpfs", `${instanceRoot}/workspaces`);

  // 6. Re-mount agent's own workspace rw (over the tmpfs that hid all workspaces)
  result.push("--bind", agentWorkspace, agentWorkspace);

  // 7. Mount working directory rw (may be same as agentWorkspace, or a project dir)
  if (cwd !== agentWorkspace) {
    result.push("--bind", cwd, cwd);
  }

  // 8. Additional read-write paths (e.g. git worktrees, project checkouts)
  if (config.additionalRwPaths) {
    for (const p of config.additionalRwPaths) {
      if (p && p !== agentWorkspace && p !== cwd) {
        result.push("--bind", p, p);
      }
    }
  }

  // 9. Additional read-only paths (e.g. skill directories under /tmp)
  if (config.additionalRoPaths) {
    for (const p of config.additionalRoPaths) {
      if (p) {
        result.push("--ro-bind", p, p);
      }
    }
  }

  // 10. Namespace and lifecycle options
  result.push("--unshare-pid");   // PID namespace: agent can't see/signal other processes
  result.push("--die-with-parent"); // Kill sandbox if parent (server) dies

  // 11. Separator and the actual command
  result.push("--", command, ...args);

  return result;
}
