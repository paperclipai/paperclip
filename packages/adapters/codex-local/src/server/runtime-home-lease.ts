import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Exclusive, reusable slots for generated Codex runtime homes.
 *
 * A generated home is content-addressed: unchanged runs of one agent select the
 * same `<digest>` directory and keep its Codex session state. A run still
 * mutates its home before launch (it relinks `auth.json` to the run's own
 * credential and writes per-run MCP bearer tokens into `config.toml`), so two
 * overlapping runs must not share one directory. Each run therefore leases a
 * slot: `<digest>` first, then `<digest>-1`, `<digest>-2`, ... Slots are reused
 * once released, so the number of homes is bounded by the agent's peak
 * concurrency instead of growing with every run.
 *
 * The lease is a sibling file `<home>.lease` created atomically (hard link of a
 * fully written temp file). It records the owning process and a per-process
 * nonce, so a lease left by a crashed or restarted server is recognised as
 * stale and taken over.
 *
 * Ownership rules that keep a live lease from being removed:
 * - A holder stays in `heldLeases` until its own lease file is gone, so this
 *   process never judges a lease stale while its release is still removing it.
 * - A lease is only ever removed in place, never moved aside, so the slot is
 *   never briefly free while it is still held.
 * - Recovering a stale lease first claims a recovery marker named after that
 *   exact lease content (created atomically, like a lease). Only the claimant
 *   re-reads the lease and removes it, and only when it still holds that same
 *   stale content. A competing recoverer of the same generation loses the
 *   claim; a new lease has different content, so it can never match a stale
 *   generation. A marker left by a recoverer that died is recovered the same way,
 *   one level deep. Deeper chains of dead recoverers are left untouched and that
 *   slot is skipped, because deleting an unclaimed marker could break exclusion.
 *
 * A caller resuming a conversation can ask for the slot that holds it
 * (`preferredHome`); the first free slot is used when that one is taken.
 */

const PROCESS_NONCE = randomUUID();
const MAX_SLOTS = 64;
// A lease name, two recovery-marker suffixes and a temp suffix stay within
// NAME_MAX (255); a third marker suffix would not. So recovery reclaims at most
// one abandoned marker above a stale lease.
const MAX_RECOVERY_DEPTH = 1;
const heldLeases = new Set<string>();
const acquireQueues = new Map<string, Promise<unknown>>();

interface LeaseHolder {
  pid: number;
  nonce: string;
  token: string;
  runId?: string;
}

export interface RuntimeHomeLease {
  home: string;
  release: () => Promise<void>;
}

export interface AcquireRuntimeHomeLeaseOptions {
  /** Basename of a slot of this digest to try first (`<digest>` or `<digest>-<n>`). */
  preferredHome?: string | null;
}

function slotHome(parentDir: string, digest: string, slot: number): string {
  return path.join(parentDir, slot === 0 ? digest : `${digest}-${slot}`);
}

/** The slot index named by `preferredHome` when it is a slot of `digest`, else null. */
function parsePreferredSlot(digest: string, preferredHome: string | null | undefined): number | null {
  if (typeof preferredHome !== "string") return null;
  if (preferredHome === digest) return 0;
  const prefix = `${digest}-`;
  if (!preferredHome.startsWith(prefix)) return null;
  const suffix = preferredHome.slice(prefix.length);
  if (!/^[1-9][0-9]*$/.test(suffix)) return null;
  const slot = Number(suffix);
  return slot < MAX_SLOTS ? slot : null;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function holderIsLive(holder: LeaseHolder | null): boolean {
  if (!holder || !Number.isInteger(holder.pid) || typeof holder.nonce !== "string") return false;
  if (holder.nonce === PROCESS_NONCE) return heldLeases.has(holder.token);
  // Same pid with another nonce is an earlier incarnation (pid reuse after a restart).
  if (holder.pid === process.pid) return false;
  return processIsAlive(holder.pid);
}

function parseHolder(raw: string): LeaseHolder | null {
  try {
    const parsed = JSON.parse(raw) as LeaseHolder;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function readLease(leaseFile: string): Promise<string | null> {
  try {
    return await fs.readFile(leaseFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Create `leaseFile` atomically with complete contents; false when it already exists. */
async function createLease(leaseFile: string, contents: string): Promise<boolean> {
  const pending = `${leaseFile}.${PROCESS_NONCE}.${randomUUID()}.tmp`;
  await fs.writeFile(pending, contents, { mode: 0o600, flag: "wx" });
  try {
    await fs.link(pending, leaseFile);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await fs.rm(pending, { force: true });
  }
}

/**
 * Remove a file judged stale (a lease, or an abandoned recovery marker), without
 * ever removing a live one. The recovery marker is keyed by the stale content,
 * so exactly one recoverer per stale generation re-reads and removes it. The
 * marker is created atomically with the recoverer's holder record and removed
 * afterwards: a later recoverer of the same generation then re-reads a
 * different (or no) file and leaves it alone, because contents are never
 * reused. A marker whose recoverer died before removing it is itself stale and
 * recovered the same way, so one crash between the two writes is recovered.
 * Recovery stops at `MAX_RECOVERY_DEPTH` marker levels to keep file names within
 * NAME_MAX; a slot behind a deeper chain of dead recoverers stays occupied and
 * acquisition moves on to the next slot.
 */
async function removeStaleFile(file: string, staleRaw: string, claim: string, depth = 0): Promise<void> {
  const generation = createHash("sha256").update(staleRaw).digest("hex").slice(0, 32);
  const marker = `${file}.recover-${generation}`;
  if (!(await createLease(marker, claim))) {
    if (depth >= MAX_RECOVERY_DEPTH) return;
    const markerRaw = await readLease(marker);
    if (markerRaw !== null && !holderIsLive(parseHolder(markerRaw))) {
      await removeStaleFile(marker, markerRaw, claim, depth + 1);
    }
    return;
  }
  try {
    if ((await readLease(file)) === staleRaw) await fs.rm(file, { force: true });
  } finally {
    await fs.rm(marker, { force: true });
  }
}

async function tryAcquireSlot(leaseFile: string, contents: string): Promise<boolean> {
  // One attempt may clear an abandoned marker and the next the stale lease.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await createLease(leaseFile, contents)) return true;
    const raw = await readLease(leaseFile);
    if (raw === null) continue;
    if (holderIsLive(parseHolder(raw))) return false;
    await removeStaleFile(leaseFile, raw, contents);
  }
  return false;
}

/**
 * Lease an exclusive generated home for `digest` under `parentDir`. The caller
 * must call `release()` on every exit path (success, failure, timeout,
 * cancellation, and setup errors).
 */
export async function acquireRuntimeHomeLease(
  parentDir: string,
  digest: string,
  runId?: string,
  options: AcquireRuntimeHomeLeaseOptions = {},
): Promise<RuntimeHomeLease> {
  const preferredSlot = parsePreferredSlot(digest, options.preferredHome);
  const slots = Array.from({ length: MAX_SLOTS }, (_, slot) => slot);
  if (preferredSlot !== null) slots.unshift(...slots.splice(preferredSlot, 1));
  const queueKey = path.resolve(parentDir, digest);
  const previous = acquireQueues.get(queueKey) ?? Promise.resolve();
  const acquisition = previous.catch(() => {}).then(async () => {
    await fs.mkdir(parentDir, { recursive: true });
    const token = randomUUID();
    const contents = JSON.stringify({ pid: process.pid, nonce: PROCESS_NONCE, token, ...(runId ? { runId } : {}) });
    for (const slot of slots) {
      const home = slotHome(parentDir, digest, slot);
      const leaseFile = `${home}.lease`;
      heldLeases.add(token);
      if (!(await tryAcquireSlot(leaseFile, contents).catch((error) => {
        heldLeases.delete(token);
        throw error;
      }))) {
        heldLeases.delete(token);
        continue;
      }
      let released = false;
      return {
        home,
        release: async () => {
          if (released) return;
          released = true;
          // Stay a live holder until the file is gone: otherwise a concurrent
          // acquisition could judge this lease stale, replace it, and then lose
          // its new lease to this removal.
          try {
            const raw = await readLease(leaseFile).catch(() => null);
            if (raw !== null && parseHolder(raw)?.token === token) await fs.rm(leaseFile, { force: true });
          } finally {
            heldLeases.delete(token);
          }
        },
      } satisfies RuntimeHomeLease;
    }
    throw new Error(
      `All ${MAX_SLOTS} Codex runtime home slots for this agent are in use; too many concurrent runs.`,
    );
  });
  acquireQueues.set(queueKey, acquisition);
  try {
    return await acquisition;
  } finally {
    if (acquireQueues.get(queueKey) === acquisition) acquireQueues.delete(queueKey);
  }
}
