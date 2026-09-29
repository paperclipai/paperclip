import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const PI_RUNTIME_MANIFEST_SCHEMA = "paperclip.pi-runtime-files.v1" as const;
export interface PiRuntimeFile {
  path: string;
  kind: "file" | "symlink";
  sha256: string;
  /** A link target is data in the manifest and must remain inside the pack. */
  target?: string;
}
export interface PiRuntimeManifest {
  schema: typeof PI_RUNTIME_MANIFEST_SCHEMA;
  node: string;
  piEntrypoint: string;
  extension: string;
  wrapperEntrypoint: string;
  files: PiRuntimeFile[];
}

function contained(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}
function safeRelative(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && !/[\0\r\n\\]/.test(path) && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
// Hash streams are bounded; at most 32 descriptors/stream buffers are live.
const PI_INVENTORY_HASH_CONCURRENCY = 32;

function hash(bytes: Uint8Array | string): string { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }

/**
 * Inventory a complete provider pack, not just Pi's cli.js. Native modules,
 * WASM, data, package metadata, and the owned extension all participate.
 * Used while building a pack; the caller records/signs this immutable result.
 */
export async function inventoryPiRuntimeFiles(root: string): Promise<PiRuntimeFile[]> {
  const physicalRoot = await realpath(root);
  if ((await lstat(root)).isSymbolicLink()) throw new Error("Pi runtime root must not be a symlink");
  const files: PiRuntimeFile[] = [];
  const regular: Array<{ path: string; entry: PiRuntimeFile }> = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory)).sort();
    for (const name of entries) {
      const path = join(directory, name);
      const rel = relative(physicalRoot, path).split(sep).join("/");
      if (!safeRelative(rel)) throw new Error("Pi runtime contains an invalid filename");
      const stat = await lstat(path);
      if (stat.isDirectory()) { await visit(path); continue; }
      if (files.length >= 100_000) throw new Error("Pi runtime file inventory exceeds its bound");
      if (stat.isSymbolicLink()) {
        const target = await readlink(path);
        if (isAbsolute(target) || !contained(physicalRoot, resolve(dirname(path), target)) || !contained(physicalRoot, await realpath(path))) throw new Error("Pi runtime link escapes its pack");
        files.push({ path: rel, kind: "symlink", target, sha256: hash(target) });
      } else if (stat.isFile()) {
        if (stat.nlink !== 1) throw new Error("Pi runtime file has another writable name");
        const entry: PiRuntimeFile = { path: rel, kind: "file", sha256: "" };
        files.push(entry); regular.push({ path, entry });
      } else throw new Error("Pi runtime contains a non-file resource");
    }
  };
  await visit(physicalRoot);
  // Keep discovery order independent of completion order. Do not cache: every
  // admission still reads every regular file through its checked descriptor.
  for (let index = 0; index < regular.length; index += PI_INVENTORY_HASH_CONCURRENCY) {
    const batch = regular.slice(index, index + PI_INVENTORY_HASH_CONCURRENCY);
    const results = await Promise.allSettled(batch.map(async ({ path, entry }) => { entry.sha256 = await hashFile(path); }));
    // Await every worker's finally/close before reporting a failed batch. No
    // subsequent batch is scheduled after a rejection.
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
  return files;
}

async function hashFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 512n * 1024n * 1024n) throw new Error("Pi runtime file identity is invalid");
    const digest = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false })) digest.update(chunk);
    const after = await file.stat({ bigint: true });
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("Pi runtime file changed during verification");
    return `sha256:${digest.digest("hex")}`;
  } finally { await file.close(); }
}

/**
 * Verify an immutable private snapshot at admission. This returns only launch
 * paths; the common command lease must continue holding its snapshot and
 * process guardian. This function alone is deliberately not a command lease.
 */
export async function verifyPiRuntimeManifest(
  root: string, manifest: PiRuntimeManifest,
): Promise<{ environment: Record<string, string>; manifestDigest: string }> {
  if (manifest.schema !== PI_RUNTIME_MANIFEST_SCHEMA || !Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > 100_000) throw new Error("Pi runtime manifest is invalid");
  const unique = new Set<string>();
  for (const entry of manifest.files) {
    if (!safeRelative(entry.path) || unique.has(entry.path) || !/^sha256:[a-f0-9]{64}$/.test(entry.sha256) || !["file", "symlink"].includes(entry.kind)) throw new Error("Pi runtime manifest entry is invalid");
    if (entry.kind === "symlink" ? typeof entry.target !== "string" : entry.target !== undefined) throw new Error("Pi runtime manifest link is invalid");
    unique.add(entry.path);
  }
  const sorted = manifest.files.map((entry): PiRuntimeFile => entry.kind === "file"
    ? { path: entry.path, kind: entry.kind, sha256: entry.sha256 }
    : { path: entry.path, kind: entry.kind, target: entry.target, sha256: entry.sha256 })
    .sort((a, b) => a.path.localeCompare(b.path, "en"));
  const actual = (await inventoryPiRuntimeFiles(root)).sort((a, b) => a.path.localeCompare(b.path, "en"));
  if (JSON.stringify(actual) !== JSON.stringify(sorted)) throw new Error("Pi runtime package graph differs from its qualified manifest");
  const physicalRoot = await realpath(root);
  const boundPath = async (path: string): Promise<string> => {
    if (!safeRelative(path) || !unique.has(path)) throw new Error("Pi executable is absent from its manifest");
    const value = await realpath(join(physicalRoot, path));
    if (!contained(physicalRoot, value) || !(await lstat(value)).isFile()) throw new Error("Pi executable escaped its verified snapshot");
    return value;
  };
  await boundPath(manifest.wrapperEntrypoint);
  return {
    environment: {
      PAPERCLIP_PI_NODE_EXECUTABLE: await boundPath(manifest.node),
      PAPERCLIP_PI_ENTRYPOINT: await boundPath(manifest.piEntrypoint),
      PAPERCLIP_PI_EXTENSION_PATH: await boundPath(manifest.extension),
    },
    manifestDigest: hash(JSON.stringify({ ...manifest, files: sorted })),
  };
}
