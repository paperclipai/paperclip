import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createGunzip } from "node:zlib";
import { desc, lt } from "drizzle-orm";
import { pluginArtifactGenerations } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import type { StorageProvider } from "../storage/types.js";
import { subscribeGlobalLiveEvents } from "./live-events.js";
import { logger } from "../middleware/logger.js";

const execFileAsync = promisify(execFile);

/**
 * Replicates the runtime plugin npm tree across replicas via full-tree
 * generation snapshots in object storage. Runtime plugin installs mutate the
 * local tree on ONE replica only; that replica publishes a tarball snapshot
 * under a monotonically increasing generation number (the
 * `plugin_artifact_generations` PK is the CAS — exactly one writer wins each
 * generation), and every replica converges to max(generation) by downloading
 * and atomically swapping in the snapshot.
 */

/**
 * Generation marker file, INSIDE the plugin tree (`<pluginsDir>/...`).
 * Integer text; absent → 0. Because the marker lives inside the tree, a
 * published snapshot embeds the publisher's marker at the time of tar-ing
 * (i.e. generation-1 relative to the snapshot itself) — that is irrelevant,
 * because reconcile always rewrites the marker AFTER swapping the tree in.
 */
const SNAPSHOT_MARKER_FILENAME = ".paperclip-snapshot-generation";

/** Object-storage key prefix for snapshot tarballs: `plugin-snapshots/gen-<n>.tgz`. */
const STORAGE_KEY_PREFIX = "plugin-snapshots/gen-";

/** Max CAS attempts when racing other publishers for the next generation. */
const PUBLISH_CAS_MAX_ATTEMPTS = 5;

/**
 * GC retention: keep the latest 3 generations (delete `generation < n - 2`
 * after publishing generation n) so lagging replicas can still fetch a
 * recent snapshot while history stays bounded.
 */
const GC_KEEP_LAST_GENERATIONS = 3;

/** Debounce for live-event-triggered reconciles (coalesces install bursts). */
const RECONCILE_DEBOUNCE_MS = 2_000;

/** Periodic reconcile safety net for missed live events. */
const RECONCILE_INTERVAL_MS = 60_000;

/**
 * Upper bound on one snapshot object download. Without it, a wedged storage
 * stream parks a reconcile pass forever — and with it the whole serialization
 * chain (later reconciles AND runExclusive mutations).
 */
const OBJECT_DOWNLOAD_TIMEOUT_MS = 60_000;

export interface PluginArtifactReplication {
  /**
   * Tar the local plugin tree, upload it, and CAS-insert the next generation
   * row. Returns the won generation, or null when replication is disabled.
   */
  publishSnapshot(): Promise<{ generation: number } | null>;
  /**
   * Converge the local tree onto max(generation): download, verify, extract,
   * atomic swap. Passes are serialized on the same chain as `runExclusive`;
   * calls made while a follow-up pass is queued coalesce onto that pass.
   * Called from INSIDE a `runExclusive` callback it runs a direct pass
   * (queueing would deadlock against the caller's own exclusive section).
   */
  reconcile(): Promise<{ applied: boolean; generation: number | null }>;
  /**
   * Run `fn` on the serialization chain reconcile passes use: while `fn`
   * runs, no reconcile can swap the tree out from under it, and once `fn`
   * starts every previously queued pass has completed. Used by the plugin
   * mutation routes to converge-then-mutate-then-publish atomically with
   * respect to this replica's reconciler. Runs `fn` directly when
   * replication is disabled.
   */
  runExclusive<T>(fn: () => Promise<T>): Promise<T>;
  /** Subscribe to plugin live events (debounced reconcile) + periodic reconcile. */
  start(): void;
  /** Unsubscribe, clear timers, and await any in-flight reconcile. */
  stop(): Promise<void>;
  /** True once the last reconcile/publish reached max generation (disabled → true). */
  isSynced(): boolean;
  /** True when replication is configured (a storage provider was supplied). */
  isActive(): boolean;
}

export function createPluginArtifactReplication(opts: {
  db: Db;
  /** null => replication disabled: every method no-ops. */
  provider: StorageProvider | null;
  pluginsDir: string;
  replicaId: string;
  mustSync?: boolean;
  /** Override for OBJECT_DOWNLOAD_TIMEOUT_MS (tests). */
  downloadTimeoutMs?: number;
  /**
   * Test-only seam for the atomic-swap renames (mirrors downloadTimeoutMs
   * pattern). Defaults to `fs.rename`. Injecting a throwing stub lets unit
   * tests verify restoration behaviour without cross-platform filesystem tricks.
   */
  renameFn?: (oldPath: string, newPath: string) => Promise<void>;
  /** Hot-reload hook; called after a successful tree swap (errors logged, not thrown). */
  onApplySnapshot: () => Promise<void>;
}): PluginArtifactReplication {
  const { db, provider, pluginsDir, replicaId, onApplySnapshot } = opts;
  const downloadTimeoutMs = opts.downloadTimeoutMs ?? OBJECT_DOWNLOAD_TIMEOUT_MS;
  const renameFn = opts.renameFn ?? fs.rename;

  let synced = false;
  let started = false;
  let unsubscribe: (() => void) | null = null;
  let intervalTimer: NodeJS.Timeout | null = null;
  let debounceTimer: NodeJS.Timeout | null = null;
  /**
   * Tail of the serialization chain shared by reconcile passes and
   * runExclusive sections: at most one of either runs at a time, so a tree
   * swap can never interleave with an exclusive mutation. The stored tail is
   * always settled-swallowed — errors reach callers via their own promise.
   */
  let serializationTail: Promise<unknown> = Promise.resolve();
  /** The reconcile pass that is queued on the chain but has not started yet. */
  let queuedReconcile: Promise<{ applied: boolean; generation: number | null }> | null = null;
  /** Truthy inside a runExclusive callback's async context (re-entrant reconcile). */
  const exclusiveContext = new AsyncLocalStorage<boolean>();

  /** Append `fn` to the serialization chain; its result/rejection is the caller's. */
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = serializationTail.then(() => fn());
    serializationTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  function markerPath(): string {
    return path.join(pluginsDir, SNAPSHOT_MARKER_FILENAME);
  }

  /** Local generation per the marker file; absent/unreadable/invalid → 0. */
  async function readLocalGeneration(): Promise<number> {
    try {
      const raw = await fs.readFile(markerPath(), "utf8");
      const parsed = Number.parseInt(raw.trim(), 10);
      return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
    } catch {
      return 0;
    }
  }

  async function writeLocalGeneration(generation: number): Promise<void> {
    await fs.writeFile(markerPath(), String(generation));
  }

  async function readMaxRow() {
    const rows = await db
      .select()
      .from(pluginArtifactGenerations)
      .orderBy(desc(pluginArtifactGenerations.generation))
      .limit(1);
    return rows[0] ?? null;
  }

  function isUniqueViolation(error: unknown): boolean {
    for (let err = error; err && typeof err === "object"; err = (err as { cause?: unknown }).cause) {
      if ((err as { code?: string }).code === "23505") return true;
    }
    return false;
  }

  function sha256Hex(body: Buffer): string {
    return createHash("sha256").update(body).digest("hex");
  }

  /**
   * Best-effort retention sweep after publishing generation `published`:
   * deletes rows AND objects older than the keep window. Never throws —
   * a failed GC only leaves harmless extra history.
   *
   * Row-first ordering: we delete the DB rows BEFORE the storage objects.
   * A reconciler re-reading max() after row deletion will skip the pruned
   * generation entirely rather than racing a missing object — a stale object
   * is harmless; a referenced-but-missing object would cause a failed download.
   */
  async function gcOldGenerations(published: number): Promise<void> {
    if (!provider) return;
    try {
      const cutoff = published - (GC_KEEP_LAST_GENERATIONS - 1);
      // Collect stale rows before deleting so we know which object keys to purge.
      const stale = await db
        .select()
        .from(pluginArtifactGenerations)
        .where(lt(pluginArtifactGenerations.generation, cutoff));
      // Delete rows first — a reconciler that re-reads max() now skips the
      // pruned generation rather than racing a missing object.
      await db.delete(pluginArtifactGenerations).where(lt(pluginArtifactGenerations.generation, cutoff));
      // Delete objects after rows; orphaned objects are harmless.
      for (const row of stale) {
        await provider.deleteObject({ objectKey: row.storageKey }).catch((err) => {
          logger.warn({ err, storageKey: row.storageKey, published }, "plugin artifact snapshot GC object delete failed (ignored)");
        });
      }
    } catch (err) {
      logger.warn({ err, published }, "plugin artifact snapshot GC failed (ignored)");
    }
  }

  async function publishSnapshot(): Promise<{ generation: number } | null> {
    if (!provider) return null;

    await fs.mkdir(pluginsDir, { recursive: true });
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-snapshot-"));
    const tmpTar = path.join(tmpDir, "snapshot.tgz");
    try {
      await execFileAsync("tar", ["-czf", tmpTar, "-C", pluginsDir, "."]);
      const body = await fs.readFile(tmpTar);
      const contentHash = sha256Hex(body);

      // CAS loop: read max(generation), upload, then try to insert max+1.
      // putObject happens BEFORE the insert on purpose — a lost race leaves
      // an orphaned object (harmless), whereas insert-before-upload would
      // advertise a generation whose object does not exist yet.
      const orphanedKeys: string[] = [];
      let wonGeneration: number | null = null;
      for (let attempt = 0; attempt < PUBLISH_CAS_MAX_ATTEMPTS; attempt += 1) {
        const maxRow = await readMaxRow();
        const generation = (maxRow?.generation ?? 0) + 1;
        const storageKey = `${STORAGE_KEY_PREFIX}${generation}.tgz`;

        await provider.putObject({
          objectKey: storageKey,
          body,
          contentType: "application/gzip",
          contentLength: body.length,
        });

        try {
          await db.insert(pluginArtifactGenerations).values({
            generation,
            storageKey,
            contentHash,
            createdBy: replicaId,
          });
        } catch (err) {
          if (isUniqueViolation(err)) {
            // Lost the race: record the orphaned object so we can clean it up
            // after we eventually win a generation.
            orphanedKeys.push(storageKey);
            continue;
          }
          throw err;
        }

        wonGeneration = generation;
        break;
      }

      // Best-effort cleanup of objects uploaded during lost CAS races. This
      // runs BEFORE the exhaustion check on purpose: orphans were never
      // inserted into the DB ledger, so GC cannot reach them — this loop is
      // their only recovery path and must cover the all-attempts-failed exit
      // too. Awaited sequentially (same never-throw discipline as GC) so the
      // caller observes a clean store state; a failed delete is harmless.
      for (const orphanKey of orphanedKeys) {
        await provider.deleteObject({ objectKey: orphanKey }).catch((err) => {
          logger.warn({ err, objectKey: orphanKey }, "plugin artifact snapshot lost-race object cleanup failed (ignored)");
        });
      }

      if (wonGeneration === null) {
        throw new Error(
          `Failed to publish plugin snapshot after ${PUBLISH_CAS_MAX_ATTEMPTS} CAS attempts (generation contention)`,
        );
      }

      // The local tree IS this generation now: record it and mark synced.
      await writeLocalGeneration(wonGeneration);
      synced = true;
      await gcOldGenerations(wonGeneration);
      return { generation: wonGeneration };
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function collectObjectBody(storageKey: string): Promise<Buffer> {
    if (!provider) throw new Error("plugin artifact replication is disabled");
    // GetObjectResult carries a Readable in `.stream` — collect it fully so
    // we can hash-verify before anything touches the live tree.
    const download = async (): Promise<Buffer> => {
      const result = await provider.getObject({ objectKey: storageKey });
      const chunks: Buffer[] = [];
      for await (const chunk of result.stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    };
    // Bounded: a wedged stream must fail the pass, not park the chain forever.
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `Plugin snapshot download timed out after ${downloadTimeoutMs}ms (${storageKey})`,
          ),
        );
      }, downloadTimeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([download(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Reject a symlink member whose target resolves outside the extraction
   * root. Plugin trees legitimately contain RELATIVE in-tree symlinks —
   * npm's `node_modules/.bin/*` links resolve like `../pkg/bin/tool.js` —
   * so targets are validated by resolving them against the link's own
   * directory rather than rejected outright for containing `..`.
   */
  function assertSymlinkTargetContained(entryName: string, target: string): void {
    const reject = () => {
      throw new Error(
        `Plugin snapshot tarball contains symlink escaping the plugin tree: ${JSON.stringify(entryName)} -> ${JSON.stringify(target)}`,
      );
    };
    if (target.length === 0 || path.posix.isAbsolute(target)) reject();
    const linkDir = path.posix.dirname(path.posix.normalize(entryName));
    const resolved = path.posix.normalize(path.posix.join(linkDir, target));
    if (path.posix.isAbsolute(resolved) || resolved === ".." || resolved.startsWith("../")) reject();
  }

  /** Reject a hardlink member whose archive-relative target is absolute or traverses `..`. */
  function assertHardlinkTargetContained(entryName: string, target: string): void {
    if (target.length === 0 || path.posix.isAbsolute(target) || target.split("/").includes("..")) {
      throw new Error(
        `Plugin snapshot tarball contains hardlink with unsafe target: ${JSON.stringify(entryName)} -> ${JSON.stringify(target)}`,
      );
    }
  }

  /** Parse pax extended-header records (`"%d key=value\n"`), failing closed on malformed data. */
  function parsePaxOverrides(content: Buffer): { path?: string; linkpath?: string } {
    const overrides: { path?: string; linkpath?: string } = {};
    let offset = 0;
    while (offset < content.length) {
      const space = content.indexOf(0x20, offset);
      const lengthText = space === -1 ? "" : content.subarray(offset, space).toString("ascii");
      const recordLength = Number.parseInt(lengthText, 10);
      if (!/^\d+$/.test(lengthText) || !Number.isInteger(recordLength) || recordLength <= 0 || offset + recordLength > content.length) {
        throw new Error("Plugin snapshot tarball contains an unparseable pax record");
      }
      const record = content.subarray(space + 1, offset + recordLength);
      const equals = record.indexOf(0x3d);
      if (equals === -1 || record.length === 0 || record[record.length - 1] !== 0x0a) {
        throw new Error("Plugin snapshot tarball contains an unparseable pax record");
      }
      const key = record.subarray(0, equals).toString("utf8");
      const value = record.subarray(equals + 1, record.length - 1).toString("utf8");
      if (key === "path") overrides.path = value;
      else if (key === "linkpath") overrides.linkpath = value;
      offset += recordLength;
    }
    return overrides;
  }

  /**
   * Walk the raw (gunzipped) tar header blocks and validate every symlink /
   * hardlink member's target FROM THE HEADER BYTES.
   *
   * The host tar's listing cannot be trusted for this check: GNU tar
   * sanitizes hard-link targets at header-decode time, so `tar -tv` prints
   * the already-stripped target (`link to outside-file` for a raw
   * `../outside-file`, warning only on stderr) and a listing-based guard
   * never sees the hostile value; bsdtar prints it raw. Reading the header
   * bytes directly is host-independent and deterministic. Handles POSIX
   * ustar, GNU longname/longlink (`L`/`K`) overrides, and pax (`x`)
   * `path=`/`linkpath=` overrides; anything unparseable — truncated
   * archive, malformed pax record, oversized metadata, global pax
   * path/linkpath overrides — fails closed. The stream is consumed
   * incrementally (headers read, file data skipped), so memory stays
   * bounded regardless of tree size.
   */
  async function assertRawLinkTargetsContained(tarPath: string): Promise<void> {
    const source = createReadStream(tarPath);
    const gunzip = createGunzip();
    source.pipe(gunzip);
    const iterator = gunzip[Symbol.asyncIterator]() as AsyncIterator<Buffer>;

    // Pull-buffer over the gunzip stream: `read` returns exactly `bytes`
    // bytes (null on clean EOF at a block boundary), `skip` discards.
    const chunks: Buffer[] = [];
    let buffered = 0;
    async function fill(target: number): Promise<boolean> {
      while (buffered < target) {
        const { value, done } = await iterator.next();
        if (done) return false;
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        chunks.push(chunk);
        buffered += chunk.length;
      }
      return true;
    }
    function drain(bytes: number, collect: boolean): Buffer {
      const parts: Buffer[] = [];
      let needed = bytes;
      while (needed > 0) {
        const head = chunks[0]!;
        if (head.length <= needed) {
          if (collect) parts.push(head);
          chunks.shift();
          needed -= head.length;
        } else {
          if (collect) parts.push(head.subarray(0, needed));
          chunks[0] = head.subarray(needed);
          needed = 0;
        }
      }
      buffered -= bytes;
      if (!collect) return Buffer.alloc(0);
      return parts.length === 1 ? parts[0]! : Buffer.concat(parts);
    }
    async function read(bytes: number): Promise<Buffer | null> {
      if (!(await fill(bytes))) {
        if (buffered === 0) return null;
        throw new Error("Plugin snapshot tarball is truncated");
      }
      return drain(bytes, true);
    }
    async function skip(bytes: number): Promise<void> {
      let remaining = bytes;
      while (remaining > 0) {
        const step = Math.min(remaining, 4 * 1024 * 1024);
        if (!(await fill(step))) throw new Error("Plugin snapshot tarball is truncated");
        drain(step, false);
        remaining -= step;
      }
    }

    const readField = (header: Buffer, offset: number, length: number): string => {
      const slice = header.subarray(offset, offset + length);
      const nul = slice.indexOf(0);
      return (nul === -1 ? slice : slice.subarray(0, nul)).toString("utf8");
    };
    const readSize = (header: Buffer): number => {
      const raw = header.subarray(124, 136);
      if ((raw[0]! & 0x80) !== 0) {
        // GNU base-256 encoding for sizes that overflow the octal field.
        let value = raw[0]! & 0x7f;
        for (let i = 1; i < raw.length; i += 1) value = value * 256 + raw[i]!;
        return value;
      }
      const text = readField(header, 124, 12).trim();
      if (text === "") return 0;
      const value = Number.parseInt(text, 8);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`Plugin snapshot tarball contains an entry with unparseable size ${JSON.stringify(text)}`);
      }
      return value;
    };

    // Longname/longlink ('L'/'K') and pax ('x') overrides apply to the NEXT
    // member; cap their payloads — link targets and paths are never megabytes.
    const MAX_META_BYTES = 1024 * 1024;
    const POSIX_MAGIC = Buffer.from("ustar\0", "latin1");
    let nameOverride: string | null = null;
    let linkOverride: string | null = null;

    try {
      for (;;) {
        const header = await read(512);
        if (header === null) break; // clean EOF
        if (header.every((byte) => byte === 0)) break; // end-of-archive marker — extraction stops here too

        const typeflag = header[156] === 0 ? "0" : String.fromCharCode(header[156]!);
        const size = readSize(header);
        const padded = Math.ceil(size / 512) * 512;

        if (typeflag === "L" || typeflag === "K" || typeflag === "x" || typeflag === "g") {
          if (size > MAX_META_BYTES) {
            throw new Error("Plugin snapshot tarball contains an oversized metadata entry");
          }
          const data = padded > 0 ? await read(padded) : Buffer.alloc(0);
          if (data === null) throw new Error("Plugin snapshot tarball is truncated");
          const content = data.subarray(0, size);
          if (typeflag === "L") {
            nameOverride = content.toString("utf8").replace(/\0+$/, "");
          } else if (typeflag === "K") {
            linkOverride = content.toString("utf8").replace(/\0+$/, "");
          } else {
            const overrides = parsePaxOverrides(content);
            if (typeflag === "g") {
              // A global pax path/linkpath override would rewrite every
              // following member — never produced for plugin snapshots.
              if (overrides.path !== undefined || overrides.linkpath !== undefined) {
                throw new Error("Plugin snapshot tarball contains a global pax path/linkpath override");
              }
            } else {
              if (overrides.path !== undefined) nameOverride = overrides.path;
              if (overrides.linkpath !== undefined) linkOverride = overrides.linkpath;
            }
          }
          continue;
        }

        let name = nameOverride ?? readField(header, 0, 100);
        if (nameOverride === null && header.subarray(257, 263).equals(POSIX_MAGIC)) {
          const prefix = readField(header, 345, 155);
          if (prefix) name = `${prefix}/${name}`;
        }
        const linkTarget = linkOverride ?? readField(header, 157, 100);
        nameOverride = null;
        linkOverride = null;

        if (typeflag === "2") {
          assertSymlinkTargetContained(name, linkTarget);
        } else if (typeflag === "1") {
          // Hardlink targets are archive-relative member names (they point
          // at an earlier member), not paths relative to the link's
          // directory — validate them exactly like entry paths.
          assertHardlinkTargetContained(name, linkTarget);
        }

        if (padded > 0) await skip(padded);
      }
    } finally {
      gunzip.destroy();
      source.destroy();
    }
  }

  /**
   * Reject tarball members that could escape the extraction directory:
   * entry paths that are absolute or contain `..` components, symlink
   * members whose target resolves above the extraction root, and hardlink
   * members whose (archive-relative) target is absolute or traverses `..`.
   * Modern GNU tar (>= 1.29) and bsdtar already skip unsafe member paths by
   * default, but that is host-tar version-dependent behaviour — verify
   * explicitly before extracting so a crafted snapshot (attacker with
   * object-storage AND DB write access, enough to also forge a matching
   * contentHash) can never write or point outside the plugin tree
   * regardless of the host tar.
   *
   * Two complementary views: the host `tar -t` listing gives the member
   * names exactly as the same binary's extraction would create them, and a
   * raw header walk validates link targets, which host listings do not
   * report faithfully (see `assertRawLinkTargetsContained`). Listing writes
   * nothing, so scanning first is safe. maxBuffer is raised because a full
   * npm tree lists tens of thousands of paths.
   */
  async function assertTarEntriesContained(tarPath: string): Promise<void> {
    const { stdout } = await execFileAsync("tar", ["-tzf", tarPath], {
      maxBuffer: 64 * 1024 * 1024,
    });
    for (const line of stdout.split("\n")) {
      const entry = line.trim();
      if (!entry) continue;
      if (path.isAbsolute(entry) || entry.split("/").includes("..")) {
        throw new Error(
          `Plugin snapshot tarball contains unsafe entry path: ${JSON.stringify(entry)}`,
        );
      }
    }
    await assertRawLinkTargetsContained(tarPath);
  }

  async function reconcileOnce(): Promise<{ applied: boolean; generation: number | null }> {
    if (!provider) return { applied: false, generation: null };

    const maxRow = await readMaxRow();
    if (!maxRow) {
      // No snapshots published yet — there is nothing to sync to, so this
      // replica is already current. Without marking synced here, a fresh
      // cluster with PAPERCLIP_PLUGINS_MUST_SYNC=true would serve 503 from
      // /api/health/ready indefinitely (no traffic → no install → no
      // snapshot → no synced → no traffic).
      synced = true;
      return { applied: false, generation: null };
    }

    const localGeneration = await readLocalGeneration();
    if (localGeneration >= maxRow.generation) {
      synced = true;
      return { applied: false, generation: maxRow.generation };
    }

    const body = await collectObjectBody(maxRow.storageKey);
    const actualHash = sha256Hex(body);
    if (actualHash !== maxRow.contentHash) {
      logger.error(
        { generation: maxRow.generation, storageKey: maxRow.storageKey, expected: maxRow.contentHash, actual: actualHash },
        "plugin snapshot content hash mismatch — refusing to apply",
      );
      throw new Error(
        `Plugin snapshot generation ${maxRow.generation} failed integrity check (content hash mismatch)`,
      );
    }

    // Extract NEXT TO the live tree (same filesystem) so the swap below is a
    // pair of atomic renames, never a partially-written live tree.
    const extractDir = `${pluginsDir}.tmp-${maxRow.generation}`;
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-snapshot-"));
    const tmpTar = path.join(tmpDir, "snapshot.tgz");
    try {
      await fs.rm(extractDir, { recursive: true, force: true });
      await fs.mkdir(extractDir, { recursive: true });
      await fs.writeFile(tmpTar, body);
      await assertTarEntriesContained(tmpTar);
      await execFileAsync("tar", ["-xzf", tmpTar, "-C", extractDir]);

      // Atomic swap: live tree → .old-<ts> (tolerate a missing live tree),
      // extracted tree → live, then best-effort cleanup of the old tree.
      // If rename(2) (extractDir→pluginsDir) fails AFTER rename(1) succeeded,
      // attempt to restore the old tree so the replica is never left without
      // a plugin directory.
      const oldDir = `${pluginsDir}.old-${Date.now()}`;
      let rename1Done = false;
      try {
        await renameFn(pluginsDir, oldDir);
        rename1Done = true;
      } catch (err) {
        if ((err as { code?: string }).code !== "ENOENT") throw err;
      }
      try {
        await renameFn(extractDir, pluginsDir);
      } catch (renameErr) {
        if (rename1Done) {
          // rename(1) moved the live tree away but rename(2) failed — restore.
          try {
            await renameFn(oldDir, pluginsDir);
          } catch (restoreErr) {
            logger.error(
              { err: restoreErr, oldDir, pluginsDir, generation: maxRow.generation },
              "plugin snapshot swap restoration failed — replica may be left without plugin directory",
            );
          }
        }
        throw renameErr;
      }
      await fs.rm(oldDir, { recursive: true, force: true }).catch(() => {});

      await writeLocalGeneration(maxRow.generation);

      // The tree is already swapped — a failing hot-reload hook must not
      // unwind that, so log instead of throwing.
      try {
        await onApplySnapshot();
      } catch (err) {
        logger.error({ err, generation: maxRow.generation }, "plugin snapshot onApplySnapshot hook failed");
      }

      synced = true;
      return { applied: true, generation: maxRow.generation };
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  function reconcile(): Promise<{ applied: boolean; generation: number | null }> {
    if (!provider) return Promise.resolve({ applied: false, generation: null });
    // Re-entrant call from inside a runExclusive callback: the chain is
    // already held by that callback, so queueing would deadlock — run a
    // direct pass; the surrounding exclusive section IS the serialization.
    if (exclusiveContext.getStore()) return reconcileOnce();
    // Coalesce: while a follow-up pass is queued but not started, additional
    // calls share it — that pass will observe every generation published
    // before it starts, so a second queued pass could never see more.
    if (queuedReconcile) return queuedReconcile;
    const pass: Promise<{ applied: boolean; generation: number | null }> = enqueue(async () => {
      // The pass is now running: stop coalescing onto it. A reconcile()
      // call from here on must queue a fresh pass to observe generations
      // committed after this pass reads max(generation).
      if (queuedReconcile === pass) queuedReconcile = null;
      return reconcileOnce();
    });
    queuedReconcile = pass;
    return pass;
  }

  function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (!provider) return fn();
    return enqueue(() => exclusiveContext.run(true, fn));
  }

  function scheduleDebouncedReconcile(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      reconcile().catch((err) => {
        logger.error({ err }, "plugin artifact reconcile (live event) failed");
      });
    }, RECONCILE_DEBOUNCE_MS);
    debounceTimer.unref?.();
  }

  function start(): void {
    if (!provider || started) return;
    started = true;
    unsubscribe = subscribeGlobalLiveEvents((event) => {
      if (event.type === "plugin.ui.updated") scheduleDebouncedReconcile();
    });
    intervalTimer = setInterval(() => {
      reconcile().catch((err) => {
        logger.error({ err }, "plugin artifact reconcile (interval) failed");
      });
    }, RECONCILE_INTERVAL_MS);
    intervalTimer.unref();
  }

  async function stop(): Promise<void> {
    started = false;
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (intervalTimer) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
    // The tail never rejects (errors are swallowed when it is stored).
    await serializationTail;
  }

  function isSynced(): boolean {
    if (!provider) return true;
    return synced;
  }

  function isActive(): boolean {
    return provider !== null;
  }

  return { publishSnapshot, reconcile, runExclusive, start, stop, isSynced, isActive };
}

// ---------------------------------------------------------------------------
// Health registry
// ---------------------------------------------------------------------------

/**
 * Readiness view of the replication handle for /api/health/ready (mirrors
 * `registerSchedulerLeadershipForHealth` in scheduler-leadership.ts).
 */
export type PluginReplicationHealth = {
  /**
   * PAPERCLIP_PLUGINS_MUST_SYNC: when true, the replica must not be routed
   * traffic until its first reconcile converged on the latest snapshot.
   */
  mustSync: boolean;
  isSynced(): boolean;
};

let healthHandle: PluginReplicationHealth | null = null;

/** Registered at startup (app.ts) so /api/health/ready can gate readiness (consumed in routes/health.ts). */
export function registerPluginReplicationForHealth(handle: PluginReplicationHealth | null): void {
  healthHandle = handle;
}

export function getRegisteredPluginReplication(): PluginReplicationHealth | null {
  return healthHandle;
}
