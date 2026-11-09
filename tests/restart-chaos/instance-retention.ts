import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const KEPT_INSTANCE_MARKER = ".restart-chaos-kept.json";
export const KEPT_INSTANCE_MAX_AGE_MS = 6 * 60 * 60_000;
const INSTANCE_PREFIX = "paperclip-runner-e2e-";

type KeepReason = "keep" | "stop_failed";

export async function keepInstance(root: string, input: { waveId: string; reason: KeepReason }, now = Date.now()): Promise<void> {
  await writeFile(path.join(root, KEPT_INSTANCE_MARKER), `${JSON.stringify({ waveId: input.waveId, reason: input.reason, keptAt: now })}\n`, { mode: 0o600 });
}

export async function releaseInstance(root: string, input: { keep: boolean; stopFailed: boolean; waveId: string },
  now = Date.now()): Promise<{ kept: false } | { kept: true; reason: KeepReason }> {
  const reason: KeepReason | null = input.stopFailed ? "stop_failed" : input.keep ? "keep" : null;
  if (!reason) {
    await rm(root, { recursive: true, force: true });
    return { kept: false };
  }
  await keepInstance(root, { waveId: input.waveId, reason }, now);
  return { kept: true, reason };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function postgresRunning(root: string): Promise<boolean> {
  const pidFile = await readFile(path.join(root, "home", "instances", "default", "db", "postmaster.pid"), "utf8").catch(() => null);
  const pid = Number(pidFile?.split("\n")[0]);
  return Number.isInteger(pid) && pid > 0 && processAlive(pid);
}

export async function sweepExpiredKeptInstances(parent = os.tmpdir(), now = Date.now(), maxAgeMs = KEPT_INSTANCE_MAX_AGE_MS): Promise<string[]> {
  const removed: string[] = [];
  for (const entry of await readdir(parent, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !entry.name.startsWith(INSTANCE_PREFIX)) continue;
    const root = path.join(parent, entry.name);
    const marker = await readFile(path.join(root, KEPT_INSTANCE_MARKER), "utf8").then(text => JSON.parse(text) as { keptAt?: unknown }).catch(() => null);
    if (typeof marker?.keptAt !== "number" || now - marker.keptAt <= maxAgeMs) continue;
    if (await postgresRunning(root)) continue;
    await rm(root, { recursive: true, force: true });
    removed.push(root);
  }
  return removed;
}
