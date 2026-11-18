import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { readCodexSkillHomeMarker, removeCodexSkillHomeTree } from "../../vendor/paperclip-runner/index.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const SCOPE_PATTERN = /^[a-f0-9]{64}$/;
const RETIRING_PATTERN = /^\.retiring-([a-f0-9]{64})\./;
const QUARANTINE_RETENTION_MS = 7 * DAY_MS;

export type CodexSkillHomeSweepResult = {
  removed: number;
  reclaimedBytes: number;
  kept: number;
  candidates: number;
};

function missing(error: NodeJS.ErrnoException): null {
  if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
  throw error;
}

async function allocatedBytes(target: string): Promise<number> {
  const info = await fs.lstat(target).catch(missing);
  if (!info) return 0;
  if (!info.isDirectory()) return info.isFile() ? info.size : 0;
  let total = 0;
  for (const name of await fs.readdir(target)) total += await allocatedBytes(path.join(target, name));
  return total;
}

async function modifiedAt(target: string): Promise<number | null> {
  return (await fs.lstat(target).catch(missing))?.mtimeMs ?? null;
}

/** Digests named by a session's `codex-home/paperclip-skill-home.json`. */
async function referencedDigests(sessionsRoot: string): Promise<Set<string>> {
  const names = await fs.readdir(sessionsRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  });
  const digests = new Set<string>();
  for (const name of names) {
    if (!SCOPE_PATTERN.test(name)) continue;
    const digest = await readCodexSkillHomeMarker(path.join(sessionsRoot, name, "codex-home"));
    if (digest) digests.add(digest);
  }
  return digests;
}

/**
 * Removes skill homes that no session's codex-home references and that were not
 * published or reused within the grace period. A home is renamed aside first and
 * restored if a launch references it before the removal.
 */
export async function sweepCodexSkillHomes(
  input: {
    storeRoot: string;
    sessionsRoot: string;
    now: number;
    graceMs?: number;
    dryRun?: boolean;
    maxRemovals?: number;
  },
  dependencies: { afterRetire?: (digest: string) => Promise<void> } = {},
): Promise<CodexSkillHomeSweepResult> {
  const result: CodexSkillHomeSweepResult = { removed: 0, reclaimedBytes: 0, kept: 0, candidates: 0 };
  const graceMs = input.graceMs ?? DAY_MS;
  const maxRemovals = input.maxRemovals ?? 50;
  const usedBefore = input.now - graceMs;
  const names = await fs.readdir(input.storeRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!names) return result;
  let referenced = await referencedDigests(input.sessionsRoot);

  for (const name of names) {
    const target = path.join(input.storeRoot, name);
    if (name.startsWith(".staging-") || name.startsWith(".retiring-")) {
      const changed = await modifiedAt(target);
      if (input.dryRun || changed === null || changed >= usedBefore) continue;
      // A sweep that stopped mid-retirement leaves `.retiring-<digest>.*`.
      const digest = RETIRING_PATTERN.exec(name)?.[1];
      const home = digest ? path.join(input.storeRoot, digest) : null;
      if (digest && home && referenced.has(digest) && !(await fs.lstat(home).catch(missing))) {
        await fs.rename(target, home);
      } else {
        await removeCodexSkillHomeTree(target);
      }
    }
  }

  const quarantine = path.join(input.storeRoot, "quarantine");
  for (const name of await fs.readdir(quarantine).catch(() => [] as string[])) {
    const target = path.join(quarantine, name);
    const changed = await modifiedAt(target);
    if (!input.dryRun && changed !== null && changed < input.now - QUARANTINE_RETENTION_MS) {
      await removeCodexSkillHomeTree(target);
    }
  }

  for (const digest of names.filter((name) => DIGEST_PATTERN.test(name)).sort()) {
    const home = path.join(input.storeRoot, digest);
    const lastUsedFile = path.join(input.storeRoot, `${digest}.last-used`);
    const lastUsed = (await modifiedAt(lastUsedFile)) ?? (await modifiedAt(home));
    if (lastUsed === null) continue;
    if (referenced.has(digest) || lastUsed >= usedBefore) {
      result.kept++;
      continue;
    }
    result.candidates++;
    if (input.dryRun || result.removed >= maxRemovals) {
      result.kept++;
      continue;
    }
    const retiring = path.join(input.storeRoot, `.retiring-${digest}.${randomUUID()}`);
    await fs.rename(home, retiring);
    await dependencies.afterRetire?.(digest);
    referenced = await referencedDigests(input.sessionsRoot);
    if (referenced.has(digest)) {
      // A launch referenced it meanwhile. If that launch already republished it,
      // its fresh copy wins and this one is discarded.
      if (await fs.lstat(home).catch(missing)) await removeCodexSkillHomeTree(retiring);
      else await fs.rename(retiring, home);
      result.kept++;
      continue;
    }
    const bytes = await allocatedBytes(retiring);
    await removeCodexSkillHomeTree(retiring);
    await fs.rm(lastUsedFile, { force: true });
    await fs.rm(path.join(input.storeRoot, `${digest}.stat.json`), { force: true });
    result.removed++;
    result.reclaimedBytes += bytes;
  }
  return result;
}
