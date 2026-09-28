import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensurePaperclipSkillSymlink,
  readPaperclipRuntimeSkillEntries,
} from '@paperclipai/adapter-utils/server-utils';
import { resolveDevinDesiredSkillNames } from './skills.js';

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

// Distinct from pid: after a server restart the new process can reuse a pid,
// but never the token, so leases written by the old process go stale.
const PROCESS_TOKEN = randomUUID();

const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
const UNSPAWNED_LEASE_MAX_AGE_MS = 10 * 60_000;

type LeaseLink = { name: string; source: string };

type DevinSkillLease = {
  runId: string;
  cwd: string;
  pid: number;
  token: string;
  // The Devin CLI child can outlive the server that spawned it (the server
  // re-adopts running children after a restart), so once known it becomes
  // the liveness source instead of the server pid/token.
  childPid?: number;
  links: LeaseLink[];
  createdAt: string;
};

function leaseDirFor(cwd: string): string {
  const hash = createHash('sha256')
    .update(path.resolve(cwd))
    .digest('hex')
    .slice(0, 16);
  return path.join(os.tmpdir(), 'paperclip-devin-skill-leases', hash);
}

function leaseFileFor(leaseDir: string, runId: string): string {
  const safe = runId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'run';
  return path.join(leaseDir, `${safe}.json`);
}

function heldKey(name: string, source: string): string {
  return `${name}${source}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isLeaseLive(lease: DevinSkillLease): boolean {
  if (typeof lease.childPid === 'number') {
    if (isPidAlive(lease.childPid)) return true;
    return lease.pid === process.pid && lease.token === PROCESS_TOKEN;
  }
  if (lease.pid === process.pid) return lease.token === PROCESS_TOKEN;
  const createdMs = Date.parse(lease.createdAt);
  if (
    Number.isFinite(createdMs) &&
    Date.now() - createdMs > UNSPAWNED_LEASE_MAX_AGE_MS
  )
    return false;
  return isPidAlive(lease.pid);
}

// Reads every lease file, deletes stale or unparseable ones, and returns the
// live leases plus the set of name+source pairs they still hold.
async function readLiveLeases(
  leaseDir: string,
): Promise<{ leases: DevinSkillLease[]; held: Set<string> }> {
  const names = await fs.readdir(leaseDir);
  const leases: DevinSkillLease[] = [];
  for (const name of names) {
    if (name === '.lock' || !name.endsWith('.json')) continue;
    const file = path.join(leaseDir, name);
    let lease: DevinSkillLease | null = null;
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof (parsed as DevinSkillLease).pid === 'number' &&
        Array.isArray((parsed as DevinSkillLease).links)
      ) {
        lease = parsed as DevinSkillLease;
      }
    } catch {
      lease = null;
    }
    if (!lease || !isLeaseLive(lease)) {
      await fs.rm(file, { force: true }).catch(() => {});
      continue;
    }
    leases.push(lease);
  }
  const held = new Set<string>();
  for (const lease of leases) {
    for (const link of lease.links) held.add(heldKey(link.name, link.source));
  }
  return { leases, held };
}

// mkdir is atomic on every supported filesystem, so it doubles as the lock.
async function withLeaseLock<T>(
  leaseDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockDir = path.join(leaseDir, '.lock');
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await fs.mkdir(lockDir);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // A concurrent release removed the lease dir between our mkdir -p
        // and the lock attempt.
        await fs.mkdir(leaseDir, { recursive: true }).catch(() => {});
        if (Date.now() >= deadline) {
          throw new Error('timed out waiting for the skill lease lock');
        }
        continue;
      }
      if (code !== 'EEXIST') throw err;
      const stat = await fs.stat(lockDir).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        // A crashed holder never releases its lock dir.
        await fs.rmdir(lockDir).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error('timed out waiting for the skill lease lock');
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rmdir(lockDir).catch(() => {});
  }
}

async function readSymlinkTarget(target: string): Promise<string | null> {
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat || !stat.isSymbolicLink()) return null;
  const linkedPath = await fs.readlink(target).catch(() => null);
  if (linkedPath === null) return null;
  return path.resolve(path.dirname(target), linkedPath);
}

/**
 * Links desired skills into <cwd>/.devin/skills for the duration of one run.
 * Concurrent runs sharing a cwd coordinate through lease files in the OS temp
 * dir; release() removes exactly the links no remaining live lease still
 * holds. Operator global skills are never read or written.
 */
export async function acquireDevinSkillLinks(opts: {
  config: Record<string, unknown>;
  cwd: string;
  runId: string;
  onLog: (stream: 'stdout' | 'stderr', chunk: string) => Promise<void>;
}): Promise<{
  release(): Promise<void>;
  recordChildPid(pid: number): Promise<void>;
}> {
  const { config, cwd, runId, onLog } = opts;
  const skillsHome = path.join(cwd, '.devin', 'skills');
  // `recorded` survives a mid-acquire failure so the fallback handle can
  // still remove the links this attempt created.
  const recorded: (LeaseLink & {
    how: 'created' | 'repaired' | 'adopted';
  })[] = [];
  let linkingAttempted = false;
  let createdSkillsDir = false;

  const makeFallbackRelease = () => {
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      for (const link of recorded) {
        if (link.how === 'adopted') continue;
        const target = path.join(skillsHome, link.name);
        try {
          if ((await readSymlinkTarget(target)) === link.source) {
            await fs.unlink(target);
          }
        } catch {
          // release never throws
        }
      }
      if (createdSkillsDir) {
        const remaining = await fs.readdir(skillsHome).catch(() => null);
        if (remaining && remaining.length === 0) {
          await fs.rmdir(skillsHome).catch(() => {});
        }
      }
    };
  };

  try {
    const availableEntries = await readPaperclipRuntimeSkillEntries(
      config,
      __moduleDir,
    );
    const desiredSet = new Set(
      resolveDevinDesiredSkillNames(config, availableEntries),
    );
    const desiredEntries = availableEntries.filter((entry) =>
      desiredSet.has(entry.key),
    );
    const leaseDir = leaseDirFor(cwd);
    const leaseFile = leaseFileFor(leaseDir, runId);

    const linkDesiredSkills = async () => {
      linkingAttempted = true;
      if (desiredEntries.length > 0) {
        const stat = await fs.lstat(skillsHome).catch(() => null);
        createdSkillsDir = !stat;
        await fs.mkdir(skillsHome, { recursive: true });
      }
      for (const entry of desiredEntries) {
        const target = path.join(skillsHome, entry.runtimeName);
        try {
          const result = await ensurePaperclipSkillSymlink(
            entry.source,
            target,
          );
          const resolved = await readSymlinkTarget(target);
          if (result === 'skipped' && resolved !== entry.source) {
            await onLog(
              'stderr',
              `[paperclip] Devin skill "${entry.key}" was not linked because its project skill path is occupied by an external installation.\n`,
            );
            continue;
          }
          recorded.push({
            name: entry.runtimeName,
            source: entry.source,
            how: result === 'skipped' ? 'adopted' : result,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await onLog(
            'stderr',
            `[paperclip] Failed to stage Devin skill "${entry.key}": ${message}\n`,
          );
        }
      }
    };

    const lease: DevinSkillLease = {
      runId,
      cwd: path.resolve(cwd),
      pid: process.pid,
      token: PROCESS_TOKEN,
      links: recorded.map(({ name, source }) => ({ name, source })),
      createdAt: new Date().toISOString(),
    };
    try {
      await fs.mkdir(leaseDir, { recursive: true });
      await withLeaseLock(leaseDir, async () => {
        const { held } = await readLiveLeases(leaseDir);
        // Leftovers from crashed runs or earlier builds of this adapter: a
        // link that provably resolves to a managed source, is not desired by
        // this run, and is held by no live lease gets removed.
        for (const entry of availableEntries) {
          if (desiredSet.has(entry.key)) continue;
          const target = path.join(skillsHome, entry.runtimeName);
          if ((await readSymlinkTarget(target)) !== entry.source) continue;
          if (held.has(heldKey(entry.runtimeName, entry.source))) continue;
          await fs.unlink(target).catch(() => {});
        }
        await linkDesiredSkills();
        lease.links = recorded.map(({ name, source }) => ({ name, source }));
        await fs.writeFile(leaseFile, JSON.stringify(lease));
      });
      await onLog(
        'stdout',
        `[paperclip] Staged ${recorded.length} Devin skill(s) in ${skillsHome} for this run\n`,
      );
      let released = false;
      return {
        recordChildPid: async (pid: number) => {
          if (released) return;
          try {
            await withLeaseLock(leaseDir, async () => {
              lease.childPid = pid;
              await fs.writeFile(leaseFile, JSON.stringify(lease));
            });
          } catch {
            // lease bookkeeping must never fail a run
          }
        },
        release: async () => {
          if (released) return;
          released = true;
          try {
            await withLeaseLock(leaseDir, async () => {
              await fs.rm(leaseFile, { force: true });
              const { leases, held } = await readLiveLeases(leaseDir);
              for (const link of recorded) {
                if (held.has(heldKey(link.name, link.source))) continue;
                const target = path.join(skillsHome, link.name);
                if ((await readSymlinkTarget(target)) === link.source) {
                  await fs.unlink(target).catch(() => {});
                }
              }
              if (leases.length === 0) {
                const remaining = await fs
                  .readdir(skillsHome)
                  .catch(() => null);
                if (remaining && remaining.length === 0) {
                  await fs.rmdir(skillsHome).catch(() => {});
                }
              }
            });
          } catch {
            // release never throws
          }
          await fs.rmdir(leaseDir).catch(() => {});
        },
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        'stderr',
        `[paperclip] Devin skill lease unavailable (${reason}); links created by this run will be removed at exit without reference counting\n`,
      );
      if (!linkingAttempted) {
        try {
          await linkDesiredSkills();
        } catch (linkErr) {
          const linkReason =
            linkErr instanceof Error ? linkErr.message : String(linkErr);
          await onLog(
            'stderr',
            `[paperclip] Failed to stage Devin skills: ${linkReason}\n`,
          );
        }
      }
      await onLog(
        'stdout',
        `[paperclip] Staged ${recorded.length} Devin skill(s) in ${skillsHome} for this run\n`,
      );
      return {
        release: makeFallbackRelease(),
        recordChildPid: async () => {},
      };
    }
  } catch (err) {
    // Staging must never fail a run.
    const reason = err instanceof Error ? err.message : String(err);
    await onLog(
      'stderr',
      `[paperclip] Failed to stage Devin skills: ${reason}\n`,
    );
    if (recorded.length > 0) {
      return {
        release: makeFallbackRelease(),
        recordChildPid: async () => {},
      };
    }
    return { release: async () => {}, recordChildPid: async () => {} };
  }
}
