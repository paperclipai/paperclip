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
const PI_INVENTORY_DISCOVERY_CONCURRENCY = 32;

function hash(bytes: Uint8Array | string): string { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }

/** Discover the complete graph with the same path, link and identity checks for both callers. */
async function discoverPiRuntimeFiles(root: string): Promise<{ files: PiRuntimeFile[]; regular: Array<{ path: string; entry: PiRuntimeFile }> }> {
  const physicalRoot = await realpath(root);
  if ((await lstat(root)).isSymbolicLink()) throw new Error("Pi runtime root must not be a symlink");
  const files: PiRuntimeFile[] = [];
  const regular: Array<{ path: string; entry: PiRuntimeFile }> = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory)).sort();
    for (let start = 0; start < entries.length; start += PI_INVENTORY_DISCOVERY_CONCURRENCY) {
      const discovered = await Promise.allSettled(entries.slice(start, start + PI_INVENTORY_DISCOVERY_CONCURRENCY).map(async name => {
        const path = join(directory, name);
        const rel = relative(physicalRoot, path).split(sep).join("/");
        if (!safeRelative(rel)) throw new Error("Pi runtime contains an invalid filename");
        return { path, rel, stat: await lstat(path) };
      }));
      // Drain every admitted operation before failure or descent. Consuming the
      // sorted batch serially preserves the original depth-first manifest order.
      const failed = discovered.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      for (const result of discovered) {
        if (result.status !== "fulfilled") continue;
        const { path, rel, stat } = result.value;
        if (stat.isDirectory()) {
          // A previous sibling may have required a complete subtree walk since
          // this batch was inspected. Never descend using that stale identity.
          const current = await lstat(path);
          if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino || await realpath(path) !== path) throw new Error("Pi runtime directory changed before traversal");
          await visit(path); continue;
        }
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
    }
  };
  await visit(physicalRoot);
  return { files, regular };
}

/**
 * Inventory a complete provider pack, not just Pi's cli.js. Native modules,
 * WASM, data, package metadata, and the owned extension all participate.
 * Used while building a pack; the caller records/signs this immutable result.
 */
export async function inventoryPiRuntimeFiles(root: string): Promise<PiRuntimeFile[]> {
  const { files, regular } = await discoverPiRuntimeFiles(root);
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
  const { sorted, unique } = validatePiRuntimeManifest(manifest);
  const actual = (await inventoryPiRuntimeFiles(root)).sort((a, b) => a.path.localeCompare(b.path, "en"));
  if (JSON.stringify(actual) !== JSON.stringify(sorted)) throw new Error("Pi runtime package graph differs from its qualified manifest");
  return bindPiRuntimeManifestPaths(root, manifest, sorted, unique);
}

function validatePiRuntimeManifest(manifest: PiRuntimeManifest): { sorted: PiRuntimeFile[]; unique: Set<string> } {
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
  return { sorted, unique };
}

async function bindPiRuntimeManifestPaths(root: string, manifest: PiRuntimeManifest, sorted: PiRuntimeFile[], unique: Set<string>): Promise<{ environment: Record<string, string>; manifestDigest: string }> {
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

/**
 * Pi's native launch already hashes every byte while creating its immutable
 * command snapshot. Check layout and both declarations here, without doing a
 * second byte pass. This result is NOT byte admission and cannot launch code;
 * the caller must still acquire a freshly verified native command snapshot.
 * The generic full-byte verifier above remains independent of this path.
 */
export async function verifyPiRuntimeLayoutForNativeSnapshot(
  root: string, manifest: PiRuntimeManifest,
  nativeManifest: unknown, expectedClosureSha256: string,
): Promise<{ manifestDigest: string }> {
  // The materializer imports the generic verifier directly from TypeScript.
  // Resolve the compiled native helper only on the runtime snapshot path.
  const { parseNativeAcpxDistributionEntries } = await import("./native-distribution-integrity.js");
  const entries = parseNativeAcpxDistributionEntries(nativeManifest, expectedClosureSha256);
  const { sorted, unique } = validatePiRuntimeManifest(manifest);
  const nativeFiles: PiRuntimeFile[] = entries.map((entry): PiRuntimeFile => ({ path: entry.path, kind: "file", sha256: `sha256:${entry.sha256}` }))
    .sort((a, b) => a.path.localeCompare(b.path, "en"));
  if (JSON.stringify(nativeFiles) !== JSON.stringify(sorted)) throw new Error("Pi runtime manifest differs from its pinned native closure");
  const { files } = await discoverPiRuntimeFiles(root);
  const layout = (values: PiRuntimeFile[]) => values.map(({ path, kind }) => ({ path, kind })).sort((a, b) => a.path.localeCompare(b.path, "en"));
  if (JSON.stringify(layout(files)) !== JSON.stringify(layout(sorted))) throw new Error("Pi runtime package graph differs from its qualified manifest");
  const { manifestDigest } = await bindPiRuntimeManifestPaths(root, manifest, sorted, unique);
  return { manifestDigest };
}
