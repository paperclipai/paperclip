import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { lstat, mkdtemp, open, opendir, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SORT_PAGE = 128;
const MERGE_FAN_IN = 32;
const CHUNK_BYTES = 64 * 1024;

/** A manifest lists the fixed provider directories, never their history. */
export function readNativeHarnessBackupManifestBytes(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > 64 * 1024) throw new Error("runner_harness_backup_manifest_invalid");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error("runner_harness_backup_changed");
      offset += count;
    }
    if (!sameMetadata(before, fstatSync(fd))) throw new Error("runner_harness_backup_changed");
    return bytes;
  } finally { closeSync(fd); }
}

async function* names(path: string): AsyncGenerator<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    let pending = "";
    for await (const chunk of file.createReadStream({ encoding: "utf8", highWaterMark: CHUNK_BYTES, autoClose: false })) {
      pending += chunk;
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        yield JSON.parse(pending.slice(0, end)) as string;
        pending = pending.slice(end + 1);
      }
      if (pending.length > 16 * 1024) throw new Error("runner_harness_backup_name_invalid");
    }
    if (pending) throw new Error("runner_harness_backup_sort_incomplete");
  } finally { await file.close(); }
}

async function merge(paths: string[], destination: string, compare: (a: string, b: string) => number): Promise<void> {
  const streams = paths.map(path => names(path));
  let output: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // Keep partially opened readers under the finally guard as well.
    const heads = [];
    for (const stream of streams) heads.push(await stream.next());
    output = await open(destination, "wx", 0o600);
    for (;;) {
      let selected = -1;
      for (let index = 0; index < heads.length; index++) {
        const head = heads[index]!;
        if (!head.done && (selected === -1 || compare(head.value, heads[selected]!.value!) < 0)) selected = index;
      }
      if (selected === -1) break;
      await output.writeFile(`${JSON.stringify(heads[selected]!.value)}\n`);
      heads[selected] = await streams[selected]!.next();
    }
  } finally {
    // A failed output close must still release every input descriptor.
    const closed = await Promise.allSettled([
      output?.close(),
      ...streams.map(stream => stream.return(undefined)),
    ]);
    const failure = closed.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
}

/** Preserve the v1 manifest's locale ordering without materializing an entire
 * directory. Runs and merge levels live in private scratch files; RAM depends
 * on page/fan-in limits, never the number of retained files. */
export async function* sortedNativeHarnessNames(directory: string, compare = (a: string, b: string) => a.localeCompare(b)): AsyncGenerator<string> {
  let scratch: string | undefined, count = 0n;
  let page: string[] = [];
  const flush = async () => {
    scratch ??= await mkdtemp(join(tmpdir(), "paperclip-backup-sort-"));
    const file = await open(join(scratch, `0-${count++}`), "wx", 0o600);
    try { await file.writeFile(page.sort(compare).map(name => JSON.stringify(name) + "\n").join("")); }
    finally { await file.close(); }
    page = [];
  };
  try {
    for await (const entry of await opendir(directory, { bufferSize: SORT_PAGE })) {
      page.push(entry.name);
      if (page.length === SORT_PAGE) await flush();
    }
    if (!scratch) { yield* page.sort(compare); return; }
    if (page.length) await flush();
    let level = 0;
    while (count > 1n) {
      let next = 0n;
      for (let first = 0n; first < count; first += BigInt(MERGE_FAN_IN)) {
        const inputs: string[] = [];
        for (let index = first; index < count && inputs.length < MERGE_FAN_IN; index++) inputs.push(join(scratch, `${level}-${index}`));
        await merge(inputs, join(scratch, `${level + 1}-${next++}`), compare);
        await Promise.all(inputs.map(path => rm(path)));
      }
      count = next;
      level++;
    }
    yield* names(join(scratch, `${level}-0`));
  } finally { if (scratch) await rm(scratch, { recursive: true, force: true }); }
}

function sameMetadata(a: Awaited<ReturnType<typeof lstat>>, b: Awaited<ReturnType<typeof lstat>>): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mode === b.mode && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/** Streaming, asynchronous v1-compatible directory digest. This is a full
 * backup verification, so I/O necessarily scales with bytes being verified;
 * ordinary continuation uses current authority and does not call it. The byte
 * total is reporting metadata; the digest includes each exact file length and
 * all its bytes. Callers still need exclusive stopped-session admission for a
 * consistent multi-store backup, not merely stable individual files. */
export async function digestNativeHarnessBackupDirectory(directory: string, options: { sync?: boolean } = {}): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256"), buffer = Buffer.alloc(CHUNK_BYTES);
  let bytes = 0;
  const visit = async (current: string, relative: string, depth: number): Promise<void> => {
    if (depth > 128) throw new Error("runner_harness_backup_path_too_deep");
    const before = await lstat(current);
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("runner_harness_backup_unsafe_directory");
    let empty = true;
    for await (const name of sortedNativeHarnessNames(current)) {
      empty = false;
      const path = join(current, name), entry = relative ? `${relative}/${name}` : name;
      const metadata = await lstat(path);
      if (metadata.isDirectory()) {
        hash.update(`directory:${entry}:${metadata.mode & 0o777}\0`);
        await visit(path, entry, depth + 1);
      } else if (metadata.isSymbolicLink()) {
        // Preserve the retained format: hash the link itself, never its target.
        hash.update(`symlink:${entry}:${await readlink(path)}\0`);
      } else if (metadata.isFile()) {
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const opened = await file.stat();
          if (!opened.isFile() || !sameMetadata(metadata, opened)) throw new Error("runner_harness_backup_changed");
          hash.update(`file:${entry}:${metadata.mode & 0o777}:${metadata.size}\0`);
          let length = 0;
          for (;;) {
            const read = await file.read(buffer, 0, buffer.length, null);
            if (!read.bytesRead) break;
            hash.update(buffer.subarray(0, read.bytesRead)); length += read.bytesRead;
          }
          if (length !== metadata.size || !sameMetadata(metadata, await file.stat())) throw new Error("runner_harness_backup_changed");
          if (options.sync) await file.sync();
          bytes += length;
        } finally { await file.close(); }
      } else throw new Error(`runner_harness_backup_unsupported_entry:${entry}`);
      if (!sameMetadata(metadata, await lstat(path))) throw new Error("runner_harness_backup_changed");
    }
    if (empty) hash.update(`directory:${relative}\0`);
    if (!sameMetadata(before, await lstat(current))) throw new Error("runner_harness_backup_changed");
    if (options.sync) await syncNativeHarnessDirectory(current);
  };
  await visit(directory, "", 0);
  return { sha256: `sha256:${hash.digest("hex")}`, bytes };
}

export async function syncNativeHarnessDirectory(directory: string): Promise<void> {
  const file = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { if (!(await file.stat()).isDirectory()) throw new Error("runner_harness_backup_unsafe_directory"); await file.sync(); }
  finally { await file.close(); }
}
