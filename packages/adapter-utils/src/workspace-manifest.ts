import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

// Limits apply to one record and to SQLite's page cache, never to the list.
export const WORKSPACE_PATH_MAX_BYTES = 64 * 1024;
export const WORKSPACE_STREAM_CHUNK_BYTES = 64 * 1024;
const DISK_CHECK_INTERVAL_BYTES = 1024 * 1024;

/** A capacity floor, not a total filename budget. Leave room for the host. */
export function assertWorkspaceManifestDiskSpace(directory: string, requiredBytes = 0): number {
  const configured = Number(process.env.PAPERCLIP_WORKSPACE_MANIFEST_MIN_FREE_BYTES);
  const minimum = Number.isSafeInteger(configured) && configured >= 64 * 1024 * 1024
    ? configured : 256 * 1024 * 1024;
  const stat = nodeFs.statfsSync(directory, { bigint: true });
  if (stat.bavail * stat.bsize < BigInt(minimum) + BigInt(requiredBytes)) {
    throw Object.assign(new Error("Workspace manifest storage is below its free-space reserve"), {
      code: "workspace_git_scan_failed",
    });
  }
  return Number(stat.bavail * stat.bsize - BigInt(minimum));
}
export interface PathManifest {
  kind: "path_manifest";
  version: 1;
  filePath: string;
  category: string;
  count: number;
}
export type WorkspacePaths = readonly string[] | PathManifest;

export function assertWorkspaceRelativePath(value: string): void {
  if (!value || value.includes("\0") || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
    || value.split(/[\\/]/).some((part) => part === ".." || part === ".")
    || Buffer.byteLength(value) > WORKSPACE_PATH_MAX_BYTES) {
    throw new Error("Invalid workspace manifest path");
  }
}

export function isPathManifest(value: WorkspacePaths): value is PathManifest {
  return !Array.isArray(value);
}

function openDatabase(filePath: string, readOnly = true): DatabaseSync {
  const db = new DatabaseSync(filePath, { readOnly, allowExtension: false });
  try {
    db.exec("PRAGMA trusted_schema=OFF; PRAGMA cache_size=-1024; PRAGMA temp_store=FILE; PRAGMA mmap_size=0;");
    return db;
  } catch (error) { db.close(); throw error; }
}

/** One private database, sealed before it is published. Consumers open read-only. */
export class WorkspaceManifestWriter {
  private readonly db: DatabaseSync;
  private readonly insert: StatementSync;
  private closed = false;
  private bytesSinceDiskCheck = 0;
  constructor(readonly filePath: string) {
    const availableBytes = assertWorkspaceManifestDiskSpace(path.dirname(filePath));
    this.db = openDatabase(filePath, false);
    try {
      // Admission follows current storage capacity, not filename-list length.
      // SQLite enforces this before allocating pages, including within a chunk.
      const pageSize = Number(this.db.prepare("PRAGMA page_size").get()!.page_size);
      const pageAllowance = Math.floor(availableBytes / 4 / pageSize);
      if (pageAllowance < 2) throw new Error("Insufficient workspace manifest disk allowance");
      this.db.exec(`PRAGMA max_page_count=${Math.min(pageAllowance, 4_294_967_294)}`);
      this.db.exec("PRAGMA journal_mode=DELETE; CREATE TABLE records(category TEXT, path TEXT, value TEXT NOT NULL, PRIMARY KEY(category,path)) WITHOUT ROWID;");
      this.insert = this.db.prepare("INSERT OR REPLACE INTO records VALUES(?,?,?)");
      this.db.exec("BEGIN");
    } catch (error) { this.db.close(); throw error; }
  }
  add(category: string, relative: string, value = ""): void {
    assertWorkspaceRelativePath(relative);
    if (Buffer.byteLength(value) > WORKSPACE_PATH_MAX_BYTES) throw new Error("Workspace manifest value exceeds record limit");
    this.bytesSinceDiskCheck += Buffer.byteLength(relative) + Buffer.byteLength(value);
    if (this.bytesSinceDiskCheck >= DISK_CHECK_INTERVAL_BYTES) {
      assertWorkspaceManifestDiskSpace(path.dirname(this.filePath));
      this.bytesSinceDiskCheck = 0;
    }
    this.insert.run(category, relative, value);
  }
  batch(work: () => void): void {
    this.db.exec("SAVEPOINT chunk");
    try { work(); this.db.exec("RELEASE chunk"); }
    catch (error) {
      // SQLITE_FULL can roll back the transaction itself.
      if (this.db.isTransaction) this.db.exec("ROLLBACK TO chunk; RELEASE chunk");
      throw error;
    }
  }
  paths(category: string): PathManifest {
    const row = this.db.prepare("SELECT count(*) AS count FROM records WHERE category=?").get(category)!;
    return { kind: "path_manifest", version: 1, filePath: this.filePath, category, count: Number(row.count) };
  }
  close(commit = true): void {
    if (this.closed) return;
    this.closed = true;
    try { if (this.db.isTransaction) this.db.exec(commit ? "COMMIT" : "ROLLBACK"); }
    finally { this.db.close(); }
  }
}

export class WorkspaceManifestMap<T> {
  private db: DatabaseSync | null = null;
  private lookup: StatementSync | null = null;
  constructor(readonly manifest: PathManifest, private readonly parse: (value: string) => T) {}
  get size(): number { return this.manifest.count; }
  get(relative: string): T | undefined {
    this.db ??= openDatabase(this.manifest.filePath);
    this.lookup ??= this.db.prepare("SELECT value FROM records WHERE category=? AND path=?");
    const row = this.lookup.get(this.manifest.category, relative);
    return row ? this.parse(String(row.value)) : undefined;
  }
  has(relative: string): boolean { return this.get(relative) !== undefined; }
  *entries(reverse = false): Generator<[string, T]> {
    for (const [relative, value] of readManifestRecords(this.manifest, reverse)) yield [relative, this.parse(value)];
  }
  [Symbol.iterator](): Generator<[string, T]> { return this.entries(); }
  close(): void { this.db?.close(); this.db = null; this.lookup = null; }
}

export async function createWorkspaceManifest(prefix = "paperclip-workspace-manifest-"): Promise<WorkspaceManifestWriter> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try { return new WorkspaceManifestWriter(path.join(directory, "paths.sqlite")); }
  catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error; }
}

export function* readManifestRecords(manifest: PathManifest, reverse = false): Generator<[string, string]> {
  const db = openDatabase(manifest.filePath);
  let count = 0;
  try {
    for (const row of db.prepare(`SELECT path,value FROM records WHERE category=? ORDER BY path ${reverse ? "DESC" : "ASC"}`).iterate(manifest.category)) {
      const relative = String(row.path);
      const value = String(row.value);
      assertWorkspaceRelativePath(relative);
      if (Buffer.byteLength(value) > WORKSPACE_PATH_MAX_BYTES) throw new Error("Invalid workspace manifest record");
      count++;
      yield [relative, value];
    }
    if (count !== manifest.count) throw new Error("Incomplete workspace manifest");
  } finally { db.close(); }
}

export function* workspacePaths(paths: WorkspacePaths): Generator<string> {
  if (isPathManifest(paths)) {
    for (const [relative] of readManifestRecords(paths)) yield relative;
  } else {
    for (const relative of paths) { assertWorkspaceRelativePath(relative); yield relative; }
  }
}

/** Exact paths and their descendants; Git ignore output is literal, not a glob. */
export function workspacePathMatcher(paths?: WorkspacePaths): { matches(relative: string): boolean; close(): void } {
  const db = paths && isPathManifest(paths) ? openDatabase(paths.filePath) : null;
  const lookup = db?.prepare("SELECT 1 FROM records WHERE category=? AND path=?");
  return {
    matches(relative) {
      let current = relative;
      while (current) {
        if (lookup && paths && isPathManifest(paths)
          ? Boolean(lookup.get(paths.category, current))
          : (paths as readonly string[] | undefined)?.includes(current)) return true;
        const slash = current.lastIndexOf("/");
        if (slash < 0) break;
        current = current.slice(0, slash);
      }
      return false;
    },
    close() { db?.close(); },
  };
}

/** Incremental NUL parser: one bounded record, strict UTF-8, no partial success. */
export class WorkspaceNulParser {
  private readonly pending = Buffer.alloc(WORKSPACE_PATH_MAX_BYTES);
  private length = 0;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  constructor(private readonly record: (relative: string) => void) {}
  write(chunk: Buffer): void {
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(0, start);
      const stop = end < 0 ? chunk.length : end;
      const size = stop - start;
      if (this.length + size > this.pending.length) throw new Error("Workspace filename exceeds per-record limit");
      chunk.copy(this.pending, this.length, start, stop);
      this.length += size;
      if (end < 0) return;
      if (!this.length) throw new Error("Empty workspace filename record");
      this.record(this.decoder.decode(this.pending.subarray(0, this.length)));
      this.length = 0;
      start = end + 1;
    }
  }
  finish(): void { if (this.length) throw new Error("Incomplete NUL-delimited workspace scan"); }
}

export async function writeWorkspacePaths(paths: WorkspacePaths, target: string): Promise<void> {
  const file = await fs.open(target, "wx", 0o600);
  try {
    for (const relative of workspacePaths(paths)) await file.writeFile(`${relative}\0`);
  } finally { await file.close(); }
}

export async function manifestFileSha256(filePath: string): Promise<string> {
  const file = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await file.stat()).isFile()) throw new Error("Invalid workspace manifest file");
    const digest = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false })) digest.update(chunk);
    return digest.digest("hex");
  } finally { await file.close(); }
}
