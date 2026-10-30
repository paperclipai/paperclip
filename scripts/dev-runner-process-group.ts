import type { ChildProcess } from "node:child_process";

export function usesProcessGroups(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

export function signalProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
): void {
  if (!usesProcessGroups(platform) || !child.pid) {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

export async function waitForProcessGroupExit(
  processGroupId: number | undefined,
  timeoutMs: number,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (!usesProcessGroups(platform) || !processGroupId) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-processGroupId, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
