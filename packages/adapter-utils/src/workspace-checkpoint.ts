import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorkspaceManifestWriter, WorkspaceManifestMap, workspacePaths } from "./workspace-manifest.js";
import { shouldExcludePath, excludePatternMatches, isRelativePathOrDescendant } from "./exclude-patterns.js";
import { openDirectorySnapshot, type DirectorySnapshot } from "./workspace-restore-merge.js";

/** Transfer metadata is disk-backed on both sides. No file list or payload is
 * buffered in a command argument, JSON array or controller heap. */
export async function writeCheckpointBaseline(snapshot: DirectorySnapshot, filePath: string): Promise<void> {
  const writer = new WorkspaceManifestWriter(filePath);
  try {
    for (const [relative, entry] of snapshot.entries) writer.add("baseline", relative, JSON.stringify(entry));
    if (snapshot.ignoredPaths) for (const relative of workspacePaths(snapshot.ignoredPaths)) writer.add("ignored", relative);
    writer.close();
  } catch (error) { writer.close(false); throw error; }
}

// This function is serialized as the provider helper. Keep dependencies explicit
// in workspaceCheckpointScript: the same path policy functions run on both ends.
async function checkpointMain(
  fs: typeof import("node:fs/promises"), path: typeof import("node:path"),
  DatabaseSync: typeof import("node:sqlite").DatabaseSync,
  createHash: typeof import("node:crypto").createHash,
  createReadStream: typeof import("node:fs").createReadStream,
  shouldExcludePath: (relative: string, exclude: readonly string[]) => boolean,
) {
  const [rootArg, baselinePath, outputDir, exclusions] = process.argv.slice(2);
  const root = await fs.realpath(rootArg!);
  const exclude: string[] = JSON.parse(exclusions!);
  await fs.mkdir(outputDir!, { recursive: true });
  const payload = path.join(outputDir!, "payload");
  await fs.mkdir(payload);
  const baseline = new DatabaseSync(baselinePath!, { readOnly: true, allowExtension: false });
  baseline.exec("PRAGMA trusted_schema=OFF; PRAGMA cache_size=-1024; PRAGMA temp_store=FILE; PRAGMA mmap_size=0;");
  const lookup = baseline.prepare("SELECT value FROM records WHERE category='baseline' AND path=?");
  const ignored = baseline.prepare("SELECT 1 FROM records WHERE category='ignored' AND path=?");
  const result = new DatabaseSync(path.join(outputDir!, "manifest.sqlite"));
  const space = await fs.statfs(outputDir!, { bigint: true });
  const available = space.bavail * space.bsize - 256n * 1024n * 1024n;
  if (available <= 0n) throw new Error("Workspace checkpoint storage is below its free-space reserve");
  result.exec(`PRAGMA max_page_count=${Math.min(Number(available / 4n / 4096n), 4_294_967_294)}`);
  result.exec("PRAGMA journal_mode=DELETE; PRAGMA cache_size=-1024; PRAGMA temp_store=FILE; CREATE TABLE records(category TEXT,path TEXT,value TEXT NOT NULL, PRIMARY KEY(category,path)) WITHOUT ROWID; BEGIN;");
  const insert = result.prepare("INSERT INTO records VALUES('baseline',?,?)");
  let files = 0, bytes = 0, scanned = 0;
  const fingerprint = (s: Awaited<ReturnType<typeof fs.lstat>>) => [s.dev, s.ino, s.mode, s.size, s.mtimeMs, s.ctimeMs].join(":");
  const hash = async (file: string) => {
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(file)) digest.update(chunk);
    return digest.digest("hex");
  };
  const walk = async (relative = "") => {
    const directory = path.join(root, relative);
    if (await fs.realpath(directory) !== directory) throw new Error("Workspace directory changed during checkpoint capture");
    for await (const child of await fs.opendir(directory)) {
      const name = relative ? `${relative}/${child.name}` : child.name;
      if (Buffer.byteLength(name) > 65536) throw new Error("Invalid workspace manifest path");
      let ignoredPath = false;
      for (let p = name; p; p = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "") {
        if (ignored.get(p)) { ignoredPath = true; break; }
      }
      if (ignoredPath || shouldExcludePath(name, exclude)) continue;
      const source = path.join(root, name);
      const before = await fs.lstat(source);
      scanned++;
      let entry: { kind: string; hash?: string; mode?: number; target?: string };
      if (before.isDirectory()) entry = { kind: "dir" };
      else if (before.isFile()) entry = { kind: "file", mode: before.mode, hash: await hash(source) };
      else if (before.isSymbolicLink()) {
        const target = await fs.readlink(source);
        const resolved = path.resolve(path.dirname(source), target);
        // Match confined full exports: omit the unsafe entry without losing
        // unrelated changed files. Never follow the link or copy its target.
        if (path.isAbsolute(target) || (resolved !== root && !resolved.startsWith(`${root}/`))) continue;
        entry = { kind: "symlink", target };
      } else continue;
      if (fingerprint(before) !== fingerprint(await fs.lstat(source))) throw new Error("Workspace changed during checkpoint capture");
      const encoded = JSON.stringify(entry);
      insert.run(name, encoded);
      if (lookup.get(name)?.value !== encoded) {
        const destination = path.join(payload, name);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        if (entry.kind === "dir") await fs.mkdir(destination, { recursive: true });
        else if (entry.kind === "symlink") await fs.symlink(entry.target!, destination);
        else {
          await fs.copyFile(source, destination);
          await fs.chmod(destination, before.mode);
          if (await hash(destination) !== entry.hash || fingerprint(before) !== fingerprint(await fs.lstat(source))) throw new Error("Workspace changed during checkpoint copy");
          files++; bytes += before.size;
        }
      }
      if (before.isDirectory()) await walk(name);
    }
  };
  try {
    await walk();
    result.exec("COMMIT");
    await fs.writeFile(path.join(outputDir!, "receipt.json"), JSON.stringify({ version: 1, files, bytes, scanned }));
  } finally { baseline.close(); result.close(); }
}

export function workspaceCheckpointScript(): string {
  // Keep wildcard policy in one source. The private segment predicate is the
  // only dependency not exported by exclude-patterns.
  return `import fs from 'node:fs/promises';\nimport path from 'node:path';\nimport { DatabaseSync } from 'node:sqlite';\nimport { createHash } from 'node:crypto';\nimport { createReadStream } from 'node:fs';\nconst __name = (fn) => fn;\n${isRelativePathOrDescendant.toString()}\nfunction pathContainsSegmentOrDescendant(relative, segment) { return relative === segment || relative.startsWith(segment + '/') || relative.endsWith('/' + segment) || relative.includes('/' + segment + '/'); }\n${excludePatternMatches.toString()}\n${shouldExcludePath.toString()}\nawait (${checkpointMain.toString()})(fs, path, DatabaseSync, createHash, createReadStream, shouldExcludePath);\n`;
}

/** Validate every manifest record before allowing a sparse source to authorize
 * deletions. SQLite is read-only, extensions and trusted schema are disabled. */
export function readCheckpointSnapshot(filePath: string, baseline: DirectorySnapshot): DirectorySnapshot {
  const db = new DatabaseSync(filePath, { readOnly: true, allowExtension: false });
  let count: number;
  try {
    db.exec("PRAGMA trusted_schema=OFF; PRAGMA cache_size=-1024; PRAGMA temp_store=FILE; PRAGMA mmap_size=0;");
    count = Number(db.prepare("SELECT count(*) AS count FROM records WHERE category='baseline'").get()!.count);
  } finally { db.close(); }
  const snapshot = openDirectorySnapshot({ version: 2, exclude: baseline.exclude, ignoredPaths: baseline.ignoredPaths,
    entries: { kind: "path_manifest", version: 1, filePath, category: "baseline", count } });
  try { for (const _entry of snapshot.entries) { /* bounded record validation */ } }
  catch (error) { (snapshot.entries as WorkspaceManifestMap<unknown>).close(); throw error; }
  return snapshot;
}

/** The manifest is provider data, not proof that the downloaded payload matches
 * it. Verify changed entries before the existing merge engine sees the source. */
export async function validateCheckpointPayload(input: { baseline: DirectorySnapshot; snapshot: DirectorySnapshot; payload: string }): Promise<WorkspaceCheckpointMetrics> {
  const { captureDirectorySnapshot, disposeDirectorySnapshot } = await import("./workspace-restore-merge.js");
  const actual = await captureDirectorySnapshot(input.payload, { diskBacked: true });
  const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  let changedFiles = 0, payloadBytes = 0;
  try {
    for (const [relative, entry] of input.snapshot.entries) {
      if (shouldExcludePath(relative, input.baseline.exclude)) throw new Error("Excluded workspace checkpoint entry");
      if (entry.kind === "symlink") {
        const target = path.resolve(input.payload, path.dirname(relative), entry.target);
        if (path.isAbsolute(entry.target) || (target !== path.resolve(input.payload) && !target.startsWith(`${path.resolve(input.payload)}/`))) {
          throw Object.assign(new Error("Unsafe workspace checkpoint symlink"), { code: "WORKSPACE_RESTORE_UNSAFE_ARCHIVE" });
        }
      }
      if (!equal(entry, input.baseline.entries.get(relative)) && !equal(entry, actual.entries.get(relative))) throw new Error("Workspace checkpoint payload mismatch");
    }
    for (const [relative, entry] of actual.entries) {
      if (!equal(entry, input.snapshot.entries.get(relative))) throw new Error("Unexpected workspace checkpoint payload");
      if (entry.kind === "file") { changedFiles++; payloadBytes += (await fs.stat(path.join(input.payload, relative))).size; }
    }
    return { mode: "sparse", scannedEntries: input.snapshot.entries.size, changedFiles, payloadBytes };
  } finally { await disposeDirectorySnapshot(actual); }
}

export interface WorkspaceCheckpointMetrics {
  mode: "sparse" | "full";
  scannedEntries: number | null;
  changedFiles: number | null;
  payloadBytes: number | null;
}
