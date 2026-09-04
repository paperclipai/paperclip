import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

/**
 * One orphan pending-cleanup record. The acquire builds it when the conditional
 * lease insert rejects a live sandbox. The record carries the same fields a
 * `pending_cleanup` lease row needs, so a later flush re-inserts it without
 * loss. The `metadata` field holds the sanitized lease metadata: it carries
 * secret references, not secret values, so the record is safe to persist next to
 * the other durable local state. A restart-recovered record still authorizes the
 * teardown, because it keeps the immutable provider, provider lease id, and
 * recorded config the teardown needs.
 */
export interface DeferredOrphanCleanupRecord {
  companyId: string;
  environmentId: string;
  executionWorkspaceId: string | null;
  issueId: string | null;
  heartbeatRunId: string | null;
  provider: string;
  providerLeaseId: string | null;
  metadata: Record<string, unknown>;
}

/**
 * A durable, restart-safe store for orphan pending-cleanup records. The acquire
 * appends a record here when the conditional lease insert rejects a live
 * sandbox, the compensating teardown fails, and every synchronous
 * `pending_cleanup` database write also fails. The database is the only
 * automated way to find a leaked sandbox, but the database is down at that
 * instant, so the record has nowhere durable to land. The in-process buffer
 * alone loses the record on a restart. This spool keeps the record on the local
 * disk, next to the other durable server state, so a restart still finds it. A
 * later cleanup sweep loads the spool, re-inserts each record as a durable
 * `pending_cleanup` row, and removes the spooled copy.
 */
export interface SandboxOrphanCleanupSpool {
  /**
   * Persist one orphan record durably. Report `true` when the record reached the
   * disk, or `false` on any failure, so the caller keeps the in-process buffer
   * and the error log as the fallback handles. This method never throws.
   */
  append(record: DeferredOrphanCleanupRecord): Promise<boolean>;
  /**
   * Load every persisted orphan record. The cleanup sweep calls this once after
   * a restart, so the records a previous process could not land re-enter the
   * flush path. This method never throws; it returns an empty list on any read
   * failure and skips a malformed file.
   */
  load(): Promise<DeferredOrphanCleanupRecord[]>;
  /**
   * Remove one persisted orphan record after its durable `pending_cleanup` row
   * lands. The removal runs after the database insert succeeds, so a crash
   * between the insert and this removal leaves the spooled copy for a later
   * flush. That later flush re-inserts a duplicate row, which the idempotent
   * teardown handles. This order never loses the orphan. This method never
   * throws.
   */
  remove(record: DeferredOrphanCleanupRecord): Promise<void>;
}

// The spool writes one file per orphan record, so a removal never rewrites a
// shared file and never races a concurrent append. The file name is a stable
// hash of the record identity, so a repeated append for the same orphan
// overwrites the same file and never persists a duplicate.
const RECORD_FILE_SUFFIX = ".json";

// A unique temp-file counter, so two concurrent appends for two different
// records never share a temp path. The atomic rename then publishes each record
// without a torn write.
let tempFileCounter = 0;

function resolveDefaultSpoolDir(): string {
  return (
    process.env.SANDBOX_ORPHAN_CLEANUP_SPOOL_DIR ??
    path.resolve(resolvePaperclipInstanceRoot(), "data", "sandbox-orphan-cleanup")
  );
}

// Build the stable file name for one record. Key on the provider lease id, the
// value the teardown needs, so a repeated append for the same orphan reuses the
// same file. A null provider lease id carries no identity, so fall back to a
// hash of the whole record. The hash keeps the name on the safe file-name
// charset and hides the raw identifiers from a directory listing.
function recordFileName(record: DeferredOrphanCleanupRecord): string {
  const identity =
    record.providerLeaseId !== null
      ? `lease:${record.providerLeaseId}`
      : `record:${JSON.stringify(record)}`;
  const hash = createHash("sha256").update(identity).digest("hex");
  return `${hash}${RECORD_FILE_SUFFIX}`;
}

function isDeferredOrphanCleanupRecord(value: unknown): value is DeferredOrphanCleanupRecord {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const stringOrNull = (field: unknown) => field === null || typeof field === "string";
  return (
    typeof candidate.companyId === "string" &&
    typeof candidate.environmentId === "string" &&
    stringOrNull(candidate.executionWorkspaceId) &&
    stringOrNull(candidate.issueId) &&
    stringOrNull(candidate.heartbeatRunId) &&
    typeof candidate.provider === "string" &&
    stringOrNull(candidate.providerLeaseId) &&
    typeof candidate.metadata === "object" &&
    candidate.metadata !== null
  );
}

// Write one file durably. Write the bytes to a unique temp file, flush the file
// to the disk, rename it onto the final path, then flush the directory. The
// rename is atomic on POSIX, so a reader never sees a torn record, and a crash
// after the directory flush still leaves the whole record on the disk.
async function writeFileDurable(absPath: string, data: string): Promise<void> {
  tempFileCounter += 1;
  const tempPath = `${absPath}.${process.pid}.${tempFileCounter}.tmp`;
  const handle = await fs.open(tempPath, "w");
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tempPath, absPath);
  } catch (error) {
    // The rename failed, so drop the temp file. Do not leave it behind, or a
    // later load reads a half-published record.
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
  const dirHandle = await fs.open(path.dirname(absPath), "r");
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close();
  }
}

/**
 * Build a local-disk orphan-cleanup spool. The spool writes one file per record
 * under the spool directory. The default directory sits next to the other
 * durable server state under the instance root. A caller can override the
 * directory for a test.
 */
export function createSandboxOrphanCleanupSpool(spoolDir?: string): SandboxOrphanCleanupSpool {
  const dir = spoolDir ?? resolveDefaultSpoolDir();

  return {
    async append(record) {
      const absPath = path.join(dir, recordFileName(record));
      try {
        await fs.mkdir(dir, { recursive: true });
        // Serialize the record only. A caught write error never enters a log,
        // because it can carry a credential in its message, code, cause, or
        // stack. So this method reports a boolean and never logs.
        await writeFileDurable(absPath, JSON.stringify(record));
        return true;
      } catch {
        return false;
      }
    },

    async load() {
      let names: string[];
      try {
        names = await fs.readdir(dir);
      } catch {
        // The directory does not exist yet, or the read failed. Either way, no
        // record waits on the disk.
        return [];
      }
      const records: DeferredOrphanCleanupRecord[] = [];
      for (const name of names) {
        if (!name.endsWith(RECORD_FILE_SUFFIX)) continue;
        try {
          const raw = await fs.readFile(path.join(dir, name), "utf8");
          const parsed: unknown = JSON.parse(raw);
          if (isDeferredOrphanCleanupRecord(parsed)) {
            records.push(parsed);
          }
        } catch {
          // Skip a malformed or unreadable file. A partial file cannot authorize
          // a teardown, so the load ignores it and keeps the other records.
        }
      }
      return records;
    },

    async remove(record) {
      const absPath = path.join(dir, recordFileName(record));
      await fs.rm(absPath, { force: true }).catch(() => undefined);
    },
  };
}
