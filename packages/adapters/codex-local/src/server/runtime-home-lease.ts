import { randomUUID } from "node:crypto";
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
 */

const PROCESS_NONCE = randomUUID();
const MAX_SLOTS = 64;
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

function slotHome(parentDir: string, digest: string, slot: number): string {
  return path.join(parentDir, slot === 0 ? digest : `${digest}-${slot}`);
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
 * Remove a lease judged stale. The rename is atomic, and the moved file is
 * checked again so that a lease another process created in the meantime is
 * put back instead of removed.
 */
async function removeStaleLease(leaseFile: string, staleRaw: string): Promise<void> {
  const aside = `${leaseFile}.${PROCESS_NONCE}.${randomUUID()}.stale`;
  try {
    await fs.rename(leaseFile, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const moved = await readLease(aside);
  if (moved !== null && moved !== staleRaw) {
    await fs.link(aside, leaseFile).catch(() => {});
  }
  await fs.rm(aside, { force: true });
}

async function tryAcquireSlot(leaseFile: string, contents: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await createLease(leaseFile, contents)) return true;
    const raw = await readLease(leaseFile);
    if (raw === null) continue;
    if (holderIsLive(parseHolder(raw))) return false;
    await removeStaleLease(leaseFile, raw);
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
): Promise<RuntimeHomeLease> {
  const queueKey = path.resolve(parentDir, digest);
  const previous = acquireQueues.get(queueKey) ?? Promise.resolve();
  const acquisition = previous.catch(() => {}).then(async () => {
    await fs.mkdir(parentDir, { recursive: true });
    const token = randomUUID();
    const contents = JSON.stringify({ pid: process.pid, nonce: PROCESS_NONCE, token, ...(runId ? { runId } : {}) });
    for (let slot = 0; slot < MAX_SLOTS; slot += 1) {
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
          heldLeases.delete(token);
          const raw = await readLease(leaseFile).catch(() => null);
          if (raw !== null && parseHolder(raw)?.token === token) await fs.rm(leaseFile, { force: true });
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
