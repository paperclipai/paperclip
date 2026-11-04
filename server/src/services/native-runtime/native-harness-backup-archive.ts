import { constants, createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, open, readdir } from "node:fs/promises";
import { join, posix } from "node:path";
import { pipeline } from "node:stream/promises";
import tar from "tar-stream";

const MAX_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 40_000;
const fail = () => new Error("native_harness_archive_invalid");
const safeName = (name: string) => name.length > 0 && !name.includes("\\")
  && !/[\u0000-\u001f\u007f]/u.test(name) && !posix.isAbsolute(name)
  && name.split("/").every(part => part !== ".." && part !== "." && part !== "");

export async function captureNativeHarnessArchive(root: string, target: string, signal?: AbortSignal) {
  if (!(await lstat(root)).isDirectory()) throw fail();
  const archive = tar.pack();
  const output = pipeline(archive, createWriteStream(target, { flags: "wx", mode: 0o600 }), { signal });
  void output.catch(() => undefined);
  let count = 0, bytes = 0;
  const visit = async (relative: string): Promise<void> => {
    for (const name of (await readdir(join(root, relative))).sort()) {
      signal?.throwIfAborted();
      const entry = relative ? `${relative}/${name}` : name;
      if (!safeName(entry) || ++count > MAX_ENTRIES) throw fail();
      const file = join(root, entry), stat = await lstat(file);
      if (stat.isDirectory()) {
        await new Promise<void>((resolve, reject) => archive.entry({ name: entry, type: "directory", mode: stat.mode & 0o777 },
          error => error ? reject(error) : resolve()));
        await visit(entry);
      } else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > MAX_BYTES) throw fail();
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const before = await handle.stat();
          if (!before.isFile() || before.ino !== stat.ino || before.dev !== stat.dev || before.size !== stat.size) throw fail();
          const stream = archive.entry({ name: entry, size: stat.size, type: "file", mode: stat.mode & 0o777 });
          await pipeline(handle.createReadStream({ autoClose: false }), stream, { signal });
          const after = await handle.stat();
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw fail();
        } finally { await handle.close(); }
      } else throw fail();
    }
  };
  try { await visit(""); archive.finalize(); await output; }
  catch (error) { archive.destroy(error as Error); await output.catch(() => undefined); throw error; }
}

export async function restoreNativeHarnessArchive(source: string, target: string, signal?: AbortSignal) {
  await mkdir(target, { mode: 0o700 });
  const archive = tar.extract(), names = new Set<string>();
  const directories: Array<{ path: string; mode: number }> = [], directoryNames = new Set<string>();
  let bytes = 0;
  archive.on("entry", (header, body, next) => {
    body.on("error", () => undefined);
    void (async () => {
      signal?.throwIfAborted();
      const name = header.type === "directory" ? header.name.replace(/\/$/u, "") : header.name;
      if (!safeName(name) || names.has(name) || names.size >= MAX_ENTRIES
        || !["directory", "file"].includes(header.type ?? "") || !Number.isSafeInteger(header.size ?? 0)
        || (header.size ?? 0) < 0 || (bytes += header.size ?? 0) > MAX_BYTES) throw fail();
      names.add(name);
      const file = join(target, name), mode = (header.mode ?? 0o600) & 0o777;
      const parent = posix.dirname(name);
      if (parent !== "." && !directoryNames.has(parent)) throw fail();
      if (header.type === "directory") {
        if (header.size) throw fail();
        await mkdir(file, { mode: 0o700 }); directories.push({ path: file, mode }); directoryNames.add(name);
        for await (const _ of body) throw fail();
      } else {
        await pipeline(body, createWriteStream(file, { flags: "wx", mode }), { signal });
        await chmod(file, mode);
      }
    })().then(() => next(), error => archive.destroy(error as Error));
  });
  await pipeline(createReadStream(source), archive, { signal });
  if (!names.has("manifest.json")) throw fail();
  for (const directory of directories.reverse()) await chmod(directory.path, directory.mode);
}
