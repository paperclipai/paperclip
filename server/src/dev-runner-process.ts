import type { ChildProcess, SpawnOptionsWithoutStdio } from "node:child_process";

type SupportedPlatform = NodeJS.Platform;

export function createManagedChildSpawnOptions(
  platform: SupportedPlatform = process.platform,
): Pick<SpawnOptionsWithoutStdio, "detached"> {
  return {
    detached: platform !== "win32",
  };
}

export function signalChildProcessTree(
  child: Pick<ChildProcess, "pid" | "kill"> | null | undefined,
  signal: NodeJS.Signals,
  platform: SupportedPlatform = process.platform,
): void {
  if (!child) return;

  if (platform !== "win32" && typeof child.pid === "number" && child.pid > 0) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child if the process group no longer exists.
    }
  }

  child.kill(signal);
}
