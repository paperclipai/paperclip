import { constants, createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readlink, symlink } from "node:fs/promises";
import { join, posix } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import tar from "tar-stream";
import { readNativeHarnessBackupSourceInput } from "./native-harness-backup-source.js";

export const MAX_NATIVE_HARNESS_BYTES = 4 * 1024 * 1024 * 1024;
export const MAX_NATIVE_HARNESS_OBJECT_BYTES = MAX_NATIVE_HARNESS_BYTES + 768 * 1024 * 1024;
export const MAX_NATIVE_HARNESS_ENTRIES = 100_000;
export const MAX_NATIVE_HARNESS_PATH_BYTES = 4096;
// PAX can store both a full path and a full symlink target for each entry.
// Two KiB also cover PAX framing, both headers and payload padding. The final
// two zero blocks terminate the archive. Keep this separate from content size.
export const MAX_NATIVE_HARNESS_TAR_OVERHEAD_BYTES = MAX_NATIVE_HARNESS_ENTRIES
  * (2 * MAX_NATIVE_HARNESS_PATH_BYTES + 2048) + 1024;
const fail = () => new Error("native_harness_archive_invalid");
export function nativeHarnessArchiveSizeLimit(contentBytes: number) {
  if (!Number.isSafeInteger(contentBytes) || contentBytes < 0 || contentBytes > MAX_NATIVE_HARNESS_BYTES) throw fail();
  return Math.min(MAX_NATIVE_HARNESS_OBJECT_BYTES, contentBytes + MAX_NATIVE_HARNESS_TAR_OVERHEAD_BYTES);
}
const safeName = (name: string) => name.length > 0 && Buffer.byteLength(name) <= MAX_NATIVE_HARNESS_PATH_BYTES && !name.includes("\\")
  && !/[\u0000-\u001f\u007f]/u.test(name) && !posix.isAbsolute(name)
  && name.split("/").every(part => part !== ".." && part !== "." && part !== "");

const safeLink = (name: string, target: string) => target.length > 0 && Buffer.byteLength(target) <= MAX_NATIVE_HARNESS_PATH_BYTES
  && !target.includes("\\") && !/[\u0000-\u001f\u007f]/u.test(target) && !posix.isAbsolute(target)
  && !["..", "."].includes(posix.normalize(posix.join(posix.dirname(name), target)))
  && !posix.normalize(posix.join(posix.dirname(name), target)).startsWith("../");
const validateLinks = (links: Map<string, string>) => {
  for (const [name, target] of links) {
    const resolved = posix.normalize(posix.join(posix.dirname(name), target)).split("/");
    for (let index = 1; index <= resolved.length; index++) {
      if (links.has(resolved.slice(0, index).join("/"))) throw fail();
    }
  }
};
const boundedArchive = (limit = MAX_NATIVE_HARNESS_OBJECT_BYTES) => {
  let bytes = 0;
  return new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    callback(bytes > limit ? fail() : null, chunk);
  } });
};

export async function captureNativeHarnessArchive(root: string, target: string, signal?: AbortSignal, maxArchiveBytes = MAX_NATIVE_HARNESS_OBJECT_BYTES) {
  if (!Number.isSafeInteger(maxArchiveBytes) || maxArchiveBytes <= 0 || maxArchiveBytes > MAX_NATIVE_HARNESS_OBJECT_BYTES) throw fail();
  if (!(await readNativeHarnessBackupSourceInput(() => lstat(root))).isDirectory()) throw fail();
  const archive = tar.pack();
  let outputFailure: unknown;
  const output = pipeline(archive, boundedArchive(maxArchiveBytes), createWriteStream(target, { flags: "wx", mode: 0o600 }), { signal });
  void output.catch(error => { outputFailure = error; });
  let count = 0, bytes = 0;
  const links = new Map<string, string>();
  const visit = async (relative: string): Promise<void> => {
    for (const name of (await readNativeHarnessBackupSourceInput(() => readdir(join(root, relative)))).sort()) {
      signal?.throwIfAborted();
      const entry = relative ? `${relative}/${name}` : name;
      if (!safeName(entry) || ++count > MAX_NATIVE_HARNESS_ENTRIES) throw fail();
      const file = join(root, entry), stat = await readNativeHarnessBackupSourceInput(() => lstat(file));
      if (stat.isDirectory()) {
        await new Promise<void>((resolve, reject) => archive.entry({ name: entry, type: "directory", mode: stat.mode & 0o777 },
          error => error ? reject(error) : resolve()));
        await visit(entry);
      } else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > MAX_NATIVE_HARNESS_BYTES) throw fail();
        const handle = await readNativeHarnessBackupSourceInput(() => open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
        try {
          const before = await readNativeHarnessBackupSourceInput(() => handle.stat());
          if (!before.isFile() || before.ino !== stat.ino || before.dev !== stat.dev || before.size !== stat.size) throw fail();
          const stream = archive.entry({ name: entry, size: stat.size, type: "file", mode: stat.mode & 0o777 });
          await pipeline(handle.createReadStream({ autoClose: false }), stream, { signal });
          const after = await readNativeHarnessBackupSourceInput(() => handle.stat());
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw fail();
        } finally { await handle.close(); }
      } else if (stat.isSymbolicLink()) {
        const linkname = await readNativeHarnessBackupSourceInput(() => readlink(file));
        if (!safeLink(entry, linkname)) throw fail();
        links.set(entry, linkname);
        await new Promise<void>((resolve, reject) => archive.entry({ name: entry, type: "symlink", linkname },
          error => error ? reject(error) : resolve()));
      } else throw fail();
    }
  };
  try { await visit(""); validateLinks(links); archive.finalize(); await output; }
  catch (error) {
    archive.destroy((outputFailure ?? error) as Error);
    await output.catch(() => undefined);
    throw outputFailure ?? error;
  }
}

export async function restoreNativeHarnessArchive(source: string, target: string, signal?: AbortSignal) {
  await mkdir(target, { mode: 0o700 });
  const archive = tar.extract(), names = new Set<string>(), links = new Map<string, string>();
  const directories: Array<{ path: string; mode: number }> = [], directoryNames = new Set<string>();
  let bytes = 0;
  archive.on("entry", (header, body, next) => {
    body.on("error", () => undefined);
    void (async () => {
      signal?.throwIfAborted();
      const name = header.type === "directory" ? header.name.replace(/\/$/u, "") : header.name;
      if (!safeName(name) || names.has(name) || names.size >= MAX_NATIVE_HARNESS_ENTRIES
        || !["directory", "file", "symlink"].includes(header.type ?? "") || !Number.isSafeInteger(header.size ?? 0)
        || (header.size ?? 0) < 0 || (bytes += header.size ?? 0) > MAX_NATIVE_HARNESS_BYTES) throw fail();
      names.add(name);
      const file = join(target, name), mode = (header.mode ?? 0o600) & 0o777;
      const parent = posix.dirname(name);
      if (parent !== "." && !directoryNames.has(parent)) throw fail();
      if (header.type === "directory") {
        if (header.size) throw fail();
        await mkdir(file, { mode: 0o700 }); directories.push({ path: file, mode }); directoryNames.add(name);
        for await (const _ of body) throw fail();
      } else if (header.type === "symlink") {
        if (header.size || !header.linkname || !safeLink(name, header.linkname)) throw fail();
        links.set(name, header.linkname);
        await symlink(header.linkname, file);
        for await (const _ of body) throw fail();
      } else {
        await pipeline(body, createWriteStream(file, { flags: "wx", mode }), { signal });
        await chmod(file, mode);
      }
    })().then(() => next(), error => archive.destroy(error as Error));
  });
  await pipeline(createReadStream(source), boundedArchive(), archive, { signal });
  if (!names.has("manifest.json")) throw fail();
  validateLinks(links);
  for (const directory of directories.reverse()) await chmod(directory.path, directory.mode);
}
