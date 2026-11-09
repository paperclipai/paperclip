import { chmod, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeDirectoryTreeRemovable } from "./directory-cleanup.js";

export const KEPT_INSTANCE_MARKER = ".paperclip-runner-e2e-kept.json";
export const KEPT_INSTANCE_MAX_AGE_MS = 6 * 60 * 60_000;
export const RUNNER_E2E_INSTANCE_PREFIX = "paperclip-runner-e2e-";
const POSTMASTER_SEARCH_DEPTH = 6;

export type KeepReason = "keep" | "stop_failed" | "recovery_state";

export async function keepInstance(root: string, input: { owner: string; reason: KeepReason }, now = Date.now()): Promise<void> {
  await chmod(root, 0o700);
  await writeFile(path.join(root, KEPT_INSTANCE_MARKER), `${JSON.stringify({ owner: input.owner, reason: input.reason, keptAt: now })}\n`, { mode: 0o600 });
}

export async function releaseInstance(root: string, input: { keep: boolean; stopFailed: boolean; owner: string; retain?: readonly string[] },
  now = Date.now()): Promise<{ kept: false } | { kept: true; reason: KeepReason }> {
  const reason: KeepReason | null = input.stopFailed ? "stop_failed" : input.keep ? "keep" : null;
  if (!reason) {
    await makeDirectoryTreeRemovable(root).catch(() => undefined);
    if (!input.retain?.length) {
      await rm(root, { recursive: true, force: true });
      return { kept: false };
    }
    const retained = new Set(input.retain);
    for (const entry of await readdir(root)) if (!retained.has(entry)) await rm(path.join(root, entry), { recursive: true, force: true });
    return { kept: false };
  }
  await keepInstance(root, { owner: input.owner, reason }, now);
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

async function postgresRunning(directory: string, depth = POSTMASTER_SEARCH_DEPTH): Promise<boolean> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isFile() && entry.name === "postmaster.pid") {
      const pid = Number((await readFile(path.join(directory, entry.name), "utf8").catch(() => "")).split("\n")[0]);
      if (Number.isInteger(pid) && pid > 0 && processAlive(pid)) return true;
    }
  }
  if (depth === 0) return false;
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink() && await postgresRunning(path.join(directory, entry.name), depth - 1)) return true;
  }
  return false;
}

export async function sweepExpiredKeptInstances(parent = os.tmpdir(), now = Date.now(), maxAgeMs = KEPT_INSTANCE_MAX_AGE_MS): Promise<string[]> {
  const removed: string[] = [];
  for (const entry of await readdir(parent, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !entry.name.startsWith(RUNNER_E2E_INSTANCE_PREFIX)) continue;
    const root = path.join(parent, entry.name);
    const marker = await readFile(path.join(root, KEPT_INSTANCE_MARKER), "utf8")
      .then(text => JSON.parse(text) as { keptAt?: unknown; reason?: unknown }).catch(() => null);
    if (typeof marker?.keptAt !== "number" || marker.reason === "recovery_state" || now - marker.keptAt <= maxAgeMs) continue;
    if (await postgresRunning(root)) continue;
    await rm(root, { recursive: true, force: true });
    removed.push(root);
  }
  return removed;
}
