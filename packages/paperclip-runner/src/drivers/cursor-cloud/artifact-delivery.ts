import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, opendir, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { CursorCloudClient } from "./cloud-client.js";
import { createHash, randomUUID } from "node:crypto";
import { reserveCursorCloudArtifactStaging } from "./artifact-staging-budget.js";

const artifactPublisherNonce = randomUUID();
const activeArtifactAliases = new Set<string>();
const retainedOwnArtifactAliases = new Map<string, { dev: number; ino: number }>();
const uuidPattern = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const artifactAliasPattern = new RegExp(`^\\.cursor-cloud-([a-f0-9]{64})-([1-9][0-9]*)-(${uuidPattern})-(${uuidPattern})\\.tmp$`);
const sameArtifactIdentity = (a: { dev: number; ino: number }, b: { dev: number; ino: number }) => a.dev === b.dev && a.ino === b.ino;
const privateArtifact = (stat: Stats) => stat.isFile() && (stat.mode & 0o077) === 0 && (!process.getuid || stat.uid === process.getuid());

function artifactPublisherIsDead(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

async function readExactArtifact(handle: FileHandle, size: number): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(bytes, offset, size - offset, offset);
    if (!result.bytesRead) throw new Error("Cursor Cloud artifact staging identity conflict");
    offset += result.bytesRead;
  }
  if ((await handle.read(Buffer.alloc(1), 0, 1, size)).bytesRead) throw new Error("Cursor Cloud artifact staging identity conflict");
  return bytes;
}

async function verifyPublishedArtifact(target: string, bytes: Buffer, sha256: string): Promise<Stats> {
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat(); const pathBefore = await lstat(target);
    if (!privateArtifact(before) || before.size !== bytes.length || !privateArtifact(pathBefore) || !sameArtifactIdentity(before, pathBefore)
      || createHash("sha256").update(await readExactArtifact(handle, bytes.length)).digest("hex") !== sha256) throw new Error("Cursor Cloud artifact staging identity conflict");
    const after = await handle.stat(); const pathAfter = await lstat(target);
    if (!privateArtifact(after) || after.size !== bytes.length || !privateArtifact(pathAfter) || !sameArtifactIdentity(before, after)
      || !sameArtifactIdentity(after, pathAfter)) throw new Error("Cursor Cloud artifact staging identity conflict");
    return after;
  } finally { await handle.close(); }
}

async function recoverPublishedArtifactAliases(input: {
  directory: string; target: string; filenameDigest: string; bytes: Buffer; sha256: string; signal: AbortSignal;
}): Promise<Stats> {
  input.signal.throwIfAborted();
  const final = await verifyPublishedArtifact(input.target, input.bytes, input.sha256);
  if (final.nlink > 1) {
    const names: string[] = [];
    for await (const entry of await opendir(input.directory)) {
      input.signal.throwIfAborted();
      if (names.length === 256) throw new Error("Cursor Cloud artifact publication recovery exceeds its directory bound");
      names.push(entry.name);
    }
    const aliases = names.map(name => ({ name, match: artifactAliasPattern.exec(name) }))
      .filter(value => value.match?.[1] === input.filenameDigest);
    if (aliases.length > 32) throw new Error("Cursor Cloud artifact publication recovery exceeds its alias bound");
    for (const { name, match } of aliases) {
      input.signal.throwIfAborted();
      const alias = join(input.directory, name); const pid = Number(match![2]);
      const own = retainedOwnArtifactAliases.get(alias);
      const finishedOwn = pid === process.pid && match![3] === artifactPublisherNonce && own !== undefined;
      if (activeArtifactAliases.has(alias) || (!finishedOwn && !artifactPublisherIsDead(pid))) continue;
      const handle = await open(alias, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(error => {
        if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
        throw error;
      });
      if (!handle) continue;
      try {
        const held = await handle.stat(); const current = await lstat(alias).catch(error => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        });
        if (!current || !privateArtifact(held) || !privateArtifact(current) || held.size !== input.bytes.length
          || !sameArtifactIdentity(held, final) || !sameArtifactIdentity(held, current) || (finishedOwn && !sameArtifactIdentity(held, own!))) continue;
        input.signal.throwIfAborted();
        const target = await lstat(input.target); const aliasBefore = await lstat(alias).catch(error => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        });
        if (!aliasBefore) continue;
        if (!privateArtifact(target) || !sameArtifactIdentity(target, final) || !privateArtifact(aliasBefore)
          || !sameArtifactIdentity(aliasBefore, held)) throw new Error("Cursor Cloud artifact publication ownership changed");
        await unlink(alias).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
        if (finishedOwn) retainedOwnArtifactAliases.delete(alias);
      } finally { await handle.close(); }
    }
  }
  const verified = await verifyPublishedArtifact(input.target, input.bytes, input.sha256);
  if (!sameArtifactIdentity(final, verified) || verified.nlink !== 1) throw new Error("Cursor Cloud artifact has unresolved publication aliases");
  return verified;
}

export async function stageCursorCloudArtifact(input: {
  arguments: unknown;
  agentId: string;
  runtimeDirectory: string;
  artifactRoot: string;
  client: Pick<CursorCloudClient, "listArtifacts" | "downloadArtifact">;
  signal: AbortSignal;
}): Promise<Record<string, unknown>> {
  if (!input.arguments || typeof input.arguments !== "object" || Array.isArray(input.arguments)) throw new Error("Cursor Cloud deliverable input must be an object");
  const args = input.arguments as Record<string, unknown>;
  if (typeof args.contentRef !== "string" || !args.contentRef.startsWith("cursor-artifact:")) throw new Error("Cursor Cloud deliverables require contentRef cursor-artifact:<listed artifact path>");
  const path = args.contentRef.slice("cursor-artifact:".length);
  if (!path || path.startsWith("/") || /[\\\0\r\n]/.test(path) || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Cursor Cloud artifact path must be a listed relative path");
  if (!Number.isSafeInteger(args.byteSize) || Number(args.byteSize) < 0 || Number(args.byteSize) > 16_777_216 || typeof args.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(args.sha256)) throw new Error("Cursor Cloud deliverables require exact byteSize and lowercase SHA-256");
  if (typeof args.filename !== "string" || !args.filename || args.filename.length > 255 || /[\x00-\x1f\x7f/\\]/.test(args.filename) || [".", ".."].includes(args.filename)) throw new Error("Cursor Cloud deliverable filename must be a single safe filename");
  if (!isAbsolute(input.artifactRoot) || resolve(input.artifactRoot) !== resolve(input.runtimeDirectory, "artifacts")) throw new Error("Cursor Cloud artifact root is outside its admitted session directory");
  const listed = await input.client.listArtifacts(input.agentId, { signal: input.signal });
  const artifact = listed.items.find(file => file.path === path);
  if (!artifact || artifact.sizeBytes !== args.byteSize) throw new Error("Cursor Cloud artifact is absent or its reported byte size does not match the claim");
  input.signal.throwIfAborted();
  const directory = join(input.artifactRoot, args.sha256);
  const contentRef = join(args.sha256, args.filename);
  const target = join(directory, args.filename);
  let cached: Buffer | null = null;
  try {
    for (const path of [input.artifactRoot, directory]) {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("Cursor Cloud artifact staging directory must be owned and private");
    }
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!privateArtifact(stat) || stat.size !== args.byteSize) throw new Error("Cursor Cloud artifact staging identity conflict");
      cached = await readExactArtifact(handle, Number(args.byteSize));
      const after = await handle.stat(), pathAfter = await lstat(target);
      if (!privateArtifact(after) || !privateArtifact(pathAfter) || !sameArtifactIdentity(stat, after)
        || !sameArtifactIdentity(after, pathAfter) || after.size !== args.byteSize || pathAfter.size !== args.byteSize
        || cached.length !== args.byteSize) throw new Error("Cursor Cloud artifact staging identity conflict");
      await verifyPublishedArtifact(target, cached, args.sha256);
    } finally { await handle.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!cached) await reserveCursorCloudArtifactStaging({ runtimeDirectory: input.runtimeDirectory, artifactRoot: input.artifactRoot, byteSize: Number(args.byteSize), signal: input.signal });
  const bytes = await input.client.downloadArtifact(input.agentId, path, { signal: input.signal, maxBytes: Math.max(1, Number(args.byteSize)) });
  if (bytes.length !== args.byteSize || createHash("sha256").update(bytes).digest("hex") !== args.sha256) throw new Error("Cursor Cloud artifact bytes do not match the claimed size/SHA-256");
  input.signal.throwIfAborted();
  if (!cached) {
    for (const root of [input.artifactRoot, directory]) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const stat = await lstat(root);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("Cursor Cloud artifact staging directory must be owned and private");
    }
  }
  const filenameDigest = createHash("sha256").update(args.filename).digest("hex");
  if (!cached) {
    const temporary = join(directory, `.cursor-cloud-${filenameDigest}-${process.pid}-${artifactPublisherNonce}-${randomUUID()}.tmp`);
    input.signal.throwIfAborted();
    const handle = await open(temporary, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    activeArtifactAliases.add(temporary);
    try {
      const held = await handle.stat();
      let published = false;
      try {
        await handle.writeFile(bytes); await handle.sync();
        const current = await lstat(temporary);
        if (!current.isFile() || current.isSymbolicLink() || current.dev !== held.dev || current.ino !== held.ino || current.size !== bytes.length
          || (current.mode & 0o077) !== 0 || (process.getuid && current.uid !== process.getuid())) throw new Error("Cursor Cloud artifact temporary ownership changed");
        input.signal.throwIfAborted();
        // A hard link publishes complete bytes without overwriting a concurrent final.
        try { await link(temporary, target); published = true; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          await verifyPublishedArtifact(target, bytes, args.sha256);
        }
      } finally {
        const current = await lstat(temporary);
        if (!current.isFile() || current.isSymbolicLink() || current.dev !== held.dev || current.ino !== held.ino) throw new Error("Cursor Cloud artifact temporary ownership changed");
        await unlink(temporary).catch(async error => {
          const retained = await lstat(temporary).catch(() => null);
          if (published && retained && privateArtifact(retained) && sameArtifactIdentity(retained, held) && retained.nlink > 1) {
            retainedOwnArtifactAliases.set(temporary, { dev: held.dev, ino: held.ino });
          }
          throw error;
        });
      }
    } finally {
      try { await handle.close(); } finally { activeArtifactAliases.delete(temporary); }
    }
  }
  const published = await recoverPublishedArtifactAliases({ directory, target, filenameDigest, bytes, sha256: args.sha256, signal: input.signal });
  // EEXIST retries also finish durability after a prior post-publication failure.
  for (const root of [directory, input.artifactRoot, input.runtimeDirectory]) {
    const handle = await open(root, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    try { await handle.sync(); } finally { await handle.close(); }
  }
  input.signal.throwIfAborted();
  const verified = await verifyPublishedArtifact(target, bytes, args.sha256);
  if (!sameArtifactIdentity(published, verified) || verified.nlink !== 1) throw new Error("Cursor Cloud artifact publication ownership changed");
  return { ...args, contentRef };
}
