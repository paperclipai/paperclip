import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import { extract, pack } from "tar-stream";
import type { CompanySkillVersionFileInventoryEntry } from "@paperclipai/shared";
import { REPOSITORY_CONTENT_DIR } from "./skill-repository-package.js";
import { assertSkillSnapshotPath, skillFileBytes, skillSnapshotHash, MAX_SKILL_SNAPSHOT_BYTES, MAX_SKILL_SNAPSHOT_FILES } from "./skill-snapshot.js";

export const MAX_SKILL_PACKAGE_BYTES = MAX_SKILL_SNAPSHOT_BYTES;
export const MAX_SKILL_PACKAGE_FILES = MAX_SKILL_SNAPSHOT_FILES;
export const MAX_SKILL_MANIFEST_BYTES = 48 * 1024 * 1024;
export type SkillPackageFile = {
  path: string;
  kind: CompanySkillVersionFileInventoryEntry["kind"];
  encoding: "utf8" | "base64";
  executable: boolean;
  size: number;
  sha256: string;
};
export type SkillPackageManifest = {
  format: "paperclip-skill-package/v1";
  contentHash: string;
  totalBytes: number;
  files: SkillPackageFile[];
};
const kinds = new Set(["skill", "markdown", "reference", "script", "asset", "other"]);
export const packageSha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

export function validateSkillPackageManifest(value: unknown): SkillPackageManifest {
  const manifest = value as SkillPackageManifest;
  if (!manifest || manifest.format !== "paperclip-skill-package/v1" || !/^[a-f0-9]{64}$/.test(manifest.contentHash)
    || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > MAX_SKILL_PACKAGE_FILES) {
    throw new Error("Invalid skill package manifest");
  }
  const paths = new Set<string>();
  let total = 0;
  for (const file of manifest.files) {
    assertSkillSnapshotPath(file.path);
    // A portable repository fork adds one generated directory to scanner-accepted paths.
    const sourcePath = file.path.startsWith(`${REPOSITORY_CONTENT_DIR}/`) ? file.path.slice(REPOSITORY_CONTENT_DIR.length + 1) : file.path;
    if (sourcePath.length > 4096 || sourcePath.split("/").length > 64 || paths.has(file.path)
      || !kinds.has(file.kind) || !["utf8", "base64"].includes(file.encoding) || typeof file.executable !== "boolean"
      || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error("Invalid skill package file");
    paths.add(file.path);
    total += file.size;
  }
  for (const file of manifest.files) {
    let parent = path.posix.dirname(file.path);
    while (parent !== ".") {
      if (paths.has(parent)) throw new Error("Conflicting skill package paths");
      parent = path.posix.dirname(parent);
    }
  }
  if (total !== manifest.totalBytes || total > MAX_SKILL_PACKAGE_BYTES) throw new Error("Skill package exceeds its byte bound");
  return manifest;
}

export function skillPackageManifest(files: CompanySkillVersionFileInventoryEntry[]): SkillPackageManifest {
  return validateSkillPackageManifest({
    format: "paperclip-skill-package/v1", contentHash: skillSnapshotHash(files),
    totalBytes: files.reduce((sum, file) => sum + skillFileBytes(file).length, 0),
    files: files.map(file => {
      const bytes = skillFileBytes(file);
      return { path: file.path, kind: file.kind, encoding: file.encoding ?? "utf8", executable: Boolean(file.executable), size: bytes.length, sha256: packageSha256(bytes) };
    }),
  });
}

/** JSONB reorders object keys. Preserve the archive manifest's v1 wire encoding
 * when a recovery recipe is read back from PostgreSQL. Array order is retained. */
export function skillPackageManifestBytes(manifest: SkillPackageManifest): Buffer {
  return Buffer.from(JSON.stringify({ format: manifest.format, contentHash: manifest.contentHash, totalBytes: manifest.totalBytes,
    files: manifest.files.map(file => ({ path: file.path, kind: file.kind, encoding: file.encoding,
      executable: file.executable, size: file.size, sha256: file.sha256 })) }));
}

export function boundedHashStream(maxBytes: number) {
  const hash = createHash("sha256");
  let bytes = 0;
  const stream = new Transform({ transform(chunk: Buffer, _encoding, done) {
    bytes += chunk.length;
    if (bytes > maxBytes) return done(new Error("Skill package stream exceeds its byte bound"));
    hash.update(chunk);
    done(null, chunk);
  } });
  return { stream, result: () => ({ bytes, sha256: hash.digest("hex") }) };
}

export async function writeSkillPackageArchive(filename: string, files: CompanySkillVersionFileInventoryEntry[], signal?: AbortSignal) {
  const archive = pack();
  const digest = boundedHashStream(MAX_SKILL_PACKAGE_BYTES + MAX_SKILL_MANIFEST_BYTES);
  const writing = pipeline(archive, createGzip({ level: 3 }), digest.stream, createWriteStream(filename, { flags: "wx", mode: 0o600 }), { signal });
  // Attach a handler before producing entries so an early filesystem failure is observed.
  void writing.catch(() => {});
  try {
    for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
      signal?.throwIfAborted();
      await new Promise<void>((resolve, reject) => archive.entry({
        name: `files/${assertSkillSnapshotPath(file.path)}`, type: "file", mode: file.executable ? 0o555 : 0o444,
        mtime: new Date(0), uid: 0, gid: 0,
      }, skillFileBytes(file), error => error ? reject(error) : resolve()));
    }
    archive.finalize();
    await writing;
    return digest.result();
  } catch (error) {
    archive.destroy(error as Error);
    await writing.catch(() => {});
    throw error;
  }
}

export async function extractSkillPackageArchive(filename: string, directory: string, manifest: SkillPackageManifest, signal?: AbortSignal) {
  const archive = extract();
  const expected = new Map(manifest.files.map(file => [`files/${file.path}`, file]));
  const expanded = boundedHashStream(MAX_SKILL_PACKAGE_BYTES + MAX_SKILL_PACKAGE_FILES * 8192);
  const reading = pipeline(createReadStream(filename), createGunzip(), expanded.stream, archive, { signal });
  void reading.catch(() => {});
  try {
    for await (const entry of archive) {
      signal?.throwIfAborted();
      const file = expected.get(entry.header.name);
      if (!file || entry.header.type !== "file" || entry.header.size !== file.size
        || entry.header.mode !== (file.executable ? 0o555 : 0o444)) throw new Error("Unexpected skill package archive entry");
      expected.delete(entry.header.name);
      const target = path.join(directory, file.path);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const digest = boundedHashStream(file.size);
      const output = await fs.open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, file.executable ? 0o555 : 0o444);
      await pipeline(entry, digest.stream, output.createWriteStream(), { signal });
      const actual = digest.result();
      if (actual.bytes !== file.size || actual.sha256 !== file.sha256) throw new Error("Skill package file checksum mismatch");
    }
    await reading;
    if (expected.size) throw new Error("Skill package archive is incomplete");
  } catch (error) {
    archive.destroy(error as Error);
    await reading.catch(() => {});
    throw error;
  }
}

export { verifyFileManifest as verifySkillPackageDirectory, relocateFileManifestVerification as relocateSkillPackageVerification } from "./file-manifest-cache.js";
