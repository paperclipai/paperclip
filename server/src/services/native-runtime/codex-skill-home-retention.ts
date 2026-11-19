import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { logger } from "../../middleware/logger.js";
import { readCodexSkillHomeMarker, removeCodexSkillHomeTree } from "../../vendor/paperclip-runner/index.js";
import { sweepAbandonedSkillStaging } from "./skill-staging-retention.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** A failed sweep looks again after this long, so unresolved cleanup is retried. */
const RETRY_MS = 60 * 60 * 1000;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const SCOPE_PATTERN = /^[a-f0-9]{64}$/;
const RETIRING_PATTERN = /^\.retiring-([a-f0-9]{64})\./;
const QUARANTINE_RETENTION_MS = 7 * DAY_MS;

/**
 * Runs the shared skill-home sweep and the abandoned-staging sweep for one
 * evidence pass and returns when the next pass must look again: the earliest
 * real deadline among what it kept (a grace period or staging age ending), now
 * when it stopped with work left, or null when nothing is pending. Homes that
 * sessions still reference wait for those sessions to go; the evidence pass that
 * removes them sweeps again. A caller that moved the state base (tests) names
 * its store and roots explicitly, so a sweep never reaches storage outside the
 * state it was given.
 */
export async function sweepSharedSkillStorage(input: {
  stateBase: string;
  stateBaseOverridden: boolean;
  /** Where ACPX keeps its sessions (`runtime/paperclip-runner/acpx/acpx`); it does not follow the state base. */
  acpxSessionsRoot: string;
  skillHomeStoreRoot?: string;
  skillStagingRoots?: string[];
  now: number;
  dryRun: boolean;
  /** Removals this pass may still make. */
  maxRemovals: number;
  shouldContinue: () => boolean;
}): Promise<{
  skillHomesRemoved: number;
  skillHomeReclaimedBytes: number;
  abandonedSkillStagingRemoved: number;
  abandonedSkillStagingBytes: number;
  failed: number;
  nextDueAt: number | null;
}> {
  const acpxSessionsRoot = input.acpxSessionsRoot;
  const storeRoot = input.skillHomeStoreRoot
    ?? (input.stateBaseOverridden ? null : path.resolve(input.stateBase, "..", "skill-homes"));
  const stagingRoots = input.skillStagingRoots ?? (input.stateBaseOverridden ? [] : [input.stateBase, acpxSessionsRoot]);
  const result = {
    skillHomesRemoved: 0, skillHomeReclaimedBytes: 0, abandonedSkillStagingRemoved: 0, abandonedSkillStagingBytes: 0,
    failed: 0, nextDueAt: null as number | null,
  };
  const due = (at: number | null) => {
    if (at !== null) result.nextDueAt = Math.min(result.nextDueAt ?? at, at);
  };
  if (storeRoot) {
    try {
      const swept = await sweepCodexSkillHomes({
        storeRoot, sessionsRoot: input.stateBase, now: input.now, dryRun: input.dryRun,
        maxRemovals: input.maxRemovals, shouldContinue: input.shouldContinue, acpxSessionsRoot,
      });
      result.skillHomesRemoved = swept.removed;
      result.skillHomeReclaimedBytes = swept.reclaimedBytes;
      due(swept.truncated ? input.now : swept.nextDueAt);
    } catch (err) {
      result.failed++;
      logger.warn({ err }, "native harness expiration skipped Codex skill homes");
      due(input.now + RETRY_MS);
    }
  }
  if (stagingRoots.length > 0) {
    try {
      const swept = await sweepAbandonedSkillStaging({
        sessionRoots: stagingRoots, now: input.now, dryRun: input.dryRun,
        maxRemovals: Math.max(0, input.maxRemovals - result.skillHomesRemoved), shouldContinue: input.shouldContinue,
      });
      result.abandonedSkillStagingRemoved = swept.removed;
      result.abandonedSkillStagingBytes = swept.bytes;
      due(swept.truncated ? input.now : swept.nextDueAt);
    } catch (err) {
      result.failed++;
      logger.warn({ err }, "native harness expiration skipped abandoned skill staging");
      due(input.now + RETRY_MS);
    }
  }
  return result;
}

export type CodexSkillHomeSweepResult = {
  removed: number;
  reclaimedBytes: number;
  kept: number;
  candidates: number;
  /** When a kept, unreferenced home or leftover becomes removable; null when none will. */
  nextDueAt: number | null;
  /** Removable homes were left because of the removal limit or a stop request. */
  truncated: boolean;
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

async function childNames(directory: string): Promise<string[]> {
  return fs.readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return [] as string[];
    throw error;
  });
}

/**
 * Digests named by `paperclip-skill-home.json` markers: native Codex
 * (`<scope>/codex-home`), OpenCode (`<scope>/opencode/<session>`) and ACPX
 * Claude (`<acpx session>/claude-home`).
 */
async function referencedDigests(sessionsRoot: string, acpxSessionsRoot?: string): Promise<Set<string>> {
  const markerDirectories: string[] = [];
  for (const scope of (await childNames(sessionsRoot)).filter((name) => SCOPE_PATTERN.test(name))) {
    markerDirectories.push(path.join(sessionsRoot, scope, "codex-home"));
    const openCode = path.join(sessionsRoot, scope, "opencode");
    for (const session of await childNames(openCode)) markerDirectories.push(path.join(openCode, session));
  }
  if (acpxSessionsRoot) {
    for (const session of await childNames(acpxSessionsRoot)) markerDirectories.push(path.join(acpxSessionsRoot, session, "claude-home"));
  }
  const digests = new Set<string>();
  for (const directory of markerDirectories) {
    const digest = await readCodexSkillHomeMarker(directory);
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
    /** ACPX session roots (`runtime/paperclip-runner/acpx/acpx`). */
    acpxSessionsRoot?: string;
    now: number;
    graceMs?: number;
    dryRun?: boolean;
    maxRemovals?: number;
    shouldContinue?: () => boolean;
  },
  dependencies: { afterRetire?: (digest: string) => Promise<void> } = {},
): Promise<CodexSkillHomeSweepResult> {
  const result: CodexSkillHomeSweepResult = {
    removed: 0, reclaimedBytes: 0, kept: 0, candidates: 0, nextDueAt: null, truncated: false,
  };
  const graceMs = input.graceMs ?? DAY_MS;
  const maxRemovals = input.maxRemovals ?? 50;
  const usedBefore = input.now - graceMs;
  const due = (at: number) => {
    result.nextDueAt = Math.min(result.nextDueAt ?? at, at);
  };
  const stopped = () => input.shouldContinue?.() === false;
  const names = await fs.readdir(input.storeRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!names) return result;
  let referenced = await referencedDigests(input.sessionsRoot, input.acpxSessionsRoot);

  for (const name of names) {
    const target = path.join(input.storeRoot, name);
    if (name.startsWith(".staging-") || name.startsWith(".retiring-")) {
      const changed = await modifiedAt(target);
      if (changed !== null && changed >= usedBefore) due(changed + graceMs);
      if (input.dryRun || changed === null || changed >= usedBefore) continue;
      if (stopped()) {
        result.truncated = true;
        continue;
      }
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
    if (changed === null) continue;
    if (changed >= input.now - QUARANTINE_RETENTION_MS) due(changed + QUARANTINE_RETENTION_MS);
    else if (stopped()) result.truncated = true;
    else if (!input.dryRun) await removeCodexSkillHomeTree(target);
  }

  for (const digest of names.filter((name) => DIGEST_PATTERN.test(name)).sort()) {
    const home = path.join(input.storeRoot, digest);
    const lastUsedFile = path.join(input.storeRoot, `${digest}.last-used`);
    const lastUsed = (await modifiedAt(lastUsedFile)) ?? (await modifiedAt(home));
    if (lastUsed === null) continue;
    if (referenced.has(digest)) {
      result.kept++;
      continue;
    }
    if (lastUsed >= usedBefore) {
      result.kept++;
      due(lastUsed + graceMs);
      continue;
    }
    result.candidates++;
    if (input.dryRun || result.removed >= maxRemovals || stopped()) {
      if (!input.dryRun) result.truncated = true;
      result.kept++;
      continue;
    }
    const retiring = path.join(input.storeRoot, `.retiring-${digest}.${randomUUID()}`);
    await fs.rename(home, retiring);
    await dependencies.afterRetire?.(digest);
    referenced = await referencedDigests(input.sessionsRoot, input.acpxSessionsRoot);
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
