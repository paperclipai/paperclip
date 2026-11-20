import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readdir, readlink, stat } from "node:fs/promises";
import { join } from "node:path";

// File hashing and archive commands on a run path must not block the event
// loop: on a slow disk one synchronous read or `execFileSync` freezes every
// lease renewal and every request in the process. These helpers keep the
// result and the error shape of the synchronous calls they replace.

/** `sha256:<hex>` of a file, streamed. */
export async function sha256FileStreamed(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk as Buffer);
  return `sha256:${hash.digest("hex")}`;
}

type CachedDigest = { key: string; digest: Promise<string> };
const digestCache = new Map<string, CachedDigest>();
const DIGEST_CACHE_LIMIT = 64;

/**
 * `sha256:<hex>` of an immutable artifact such as the runner binary. The digest
 * is reused while the file's device, inode, size, modification and change times
 * are unchanged, so every run of a boot reads it at most once.
 */
export async function cachedFileSha256(path: string): Promise<string> {
  const metadata = await stat(path, { bigint: true });
  const key = [metadata.dev, metadata.ino, metadata.size, metadata.mtimeNs, metadata.ctimeNs].join(":");
  const cached = digestCache.get(path);
  if (cached?.key === key) return cached.digest;
  const digest = sha256FileStreamed(path);
  digestCache.set(path, { key, digest });
  if (digestCache.size > DIGEST_CACHE_LIMIT) digestCache.delete(digestCache.keys().next().value!);
  digest.catch(() => {
    if (digestCache.get(path)?.digest === digest) digestCache.delete(path);
  });
  return digest;
}

/** Test seam: forget every cached digest. */
export function clearCachedFileSha256(): void {
  digestCache.clear();
}

const HEADER_BYTES = 64 * 1024;

/**
 * The executable target of a native binary from its header. Reads the rest of
 * the file only when the header alone cannot answer (a PE header past 64 KiB),
 * so the result always equals `classify(readFileSync(path))`.
 */
export async function binaryTargetFromHeader(
  path: string,
  classify: (bytes: Buffer) => string | null,
): Promise<string | null> {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(HEADER_BYTES);
    let length = 0;
    let ended = false;
    while (length < HEADER_BYTES) {
      const { bytesRead } = await handle.read(header, length, HEADER_BYTES - length, null);
      if (bytesRead === 0) { ended = true; break; }
      length += bytesRead;
    }
    const target = classify(header.subarray(0, length));
    if (target !== null || ended) return target;
    return classify(Buffer.concat([header.subarray(0, length), await handle.readFile()]));
  } finally {
    await handle.close();
  }
}

/** `sha256:<hex>` of a directory tree, in the format of `sha256DirectoryTree`. */
export async function sha256DirectoryTreeStreamed(
  root: string,
  unsupported: (relativePath: string) => Error,
): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directory: string, prefix = ""): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        hash.update(`directory\0${relativePath}\n`);
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        hash.update(`file\0${relativePath}\0${await sha256FileStreamed(absolutePath)}\n`);
      } else if (entry.isSymbolicLink()) {
        hash.update(`symlink\0${relativePath}\0${await readlink(absolutePath)}\n`);
      } else {
        throw unsupported(relativePath);
      }
    }
  };
  await visit(root);
  return `sha256:${hash.digest("hex")}`;
}

export type FileCommandOptions = {
  input?: Buffer;
  maxBuffer: number;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
};

/**
 * Runs a command like `execFileSync(file, args, { encoding: "buffer", ... })`,
 * without blocking the event loop: it resolves with stdout and rejects when the
 * command exits non-zero, is killed by the timeout, or exceeds `maxBuffer`.
 */
export function execFileBuffered(file: string, args: readonly string[], options: FileCommandOptions): Promise<Buffer> {
  return new Promise((resolveOutput, rejectOutput) => {
    const child = execFile(file, [...args], {
      encoding: "buffer",
      maxBuffer: options.maxBuffer,
      ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
      ...(options.env ? { env: options.env } : {}),
    }, (error, stdout) => {
      if (error) rejectOutput(error);
      else resolveOutput(stdout);
    });
    // A command can exit before it reads all of its input; its exit status,
    // not the broken pipe, decides the result (as with execFileSync).
    child.stdin?.on("error", () => undefined);
    if (options.input) child.stdin?.end(options.input);
    else child.stdin?.end();
  });
}
