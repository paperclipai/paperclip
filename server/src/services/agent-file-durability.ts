import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { and, eq } from "drizzle-orm";
import { agentFileRoots, type Db, type DurableAgentFileEntry } from "@paperclipai/db";
import { HttpError } from "../errors.js";
import { getStorageService } from "../storage/index.js";
import { assertInstructionPathSafe, instructionPath } from "./agent-instruction-files.js";
import { cachedAgentFileManifest } from "./agent-file-checkpoints.js";
import { AgentFileLimitError, MAX_AGENT_DIRECTORY_BYTES, MAX_AGENT_DIRECTORY_ENTRIES, MAX_AGENT_FILE_BYTES } from "./agent-file-store.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Owner = { companyId: string; id: string; createdAt: Date };
type Head = typeof agentFileRoots.$inferSelect;
const where = (owner: Owner) => and(eq(agentFileRoots.companyId, owner.companyId), eq(agentFileRoots.agentId, owner.id));
const marker = (root: string) => path.join(path.dirname(root), "file-sync", "durable-generation");
const adoptionReceipt = (root: string) => path.join(path.dirname(root), "file-sync", "durable-adoption.json");
export const durableAgentFilesEnabled = () => process.env.PAPERCLIP_DURABLE_AGENT_FILES === "true";

/** A newly created agent has no legacy files to import. Commit its empty
 * authority with the agent row, before any API can acknowledge file mutations. */
export async function initializeDurableAgentFiles(tx: Db, owner: { companyId: string; id: string }) {
  if (!durableAgentFilesEnabled()) return;
  storage();
  await tx.insert(agentFileRoots).values({ companyId: owner.companyId, agentId: owner.id,
    generation: randomUUID(), entries: [] }).onConflictDoNothing();
}

function storage() {
  const service = getStorageService();
  if (service.provider !== "s3") throw new HttpError(503, "Durable agent files require shared object storage");
  return service;
}

/** Call before changing a projection: a failed write must not leave a valid cache marker. */
export async function invalidateAgentFileProjection(root: string) {
  await fs.rm(marker(root), { force: true });
}
async function mark(root: string, generation: string) {
  await atomicPrivateWrite(marker(root), generation);
}
async function atomicPrivateWrite(filename: string, contents: string) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}`;
  try {
    await fs.writeFile(temporary, contents, { mode: 0o600 });
    await fs.rename(temporary, filename);
  } finally { await fs.rm(temporary, { force: true }); }
}

/** Under the agent row lock. A durable head remains authoritative even after
 * the opt-in is removed; silently falling back would lose acknowledged writes. */
export async function restoreDurableAgentFiles(tx: Tx, owner: Owner, root: string): Promise<boolean> {
  let [head] = await tx.select().from(agentFileRoots).where(where(owner));
  if (!head) {
    const filename = await assertInstructionPathSafe(path.dirname(adoptionReceipt(root)), path.basename(adoptionReceipt(root)));
    const contents = await fs.readFile(filename, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (contents !== null) {
      const receipt = JSON.parse(contents) as { version: number; agentCreatedAt: string; head: Head };
      if (receipt.version !== 1 || receipt.head.companyId !== owner.companyId || receipt.head.agentId !== owner.id
        || receipt.agentCreatedAt !== owner.createdAt.toISOString() || !Array.isArray(receipt.head.entries)) {
        throw new Error("Agent file adoption receipt does not match its owner");
      }
      // A first save can roll back the head after changing local files. Replay
      // only the pre-mutation manifest whose immutable bytes were uploaded,
      // never adopt the now-dirty directory as fresh legacy input.
      [head] = await tx.insert(agentFileRoots).values({ companyId: owner.companyId, agentId: owner.id,
        generation: receipt.head.generation, entries: receipt.head.entries }).returning();
      await invalidateAgentFileProjection(root);
    }
  }
  if (!head) return false;
  const service = storage();
  const generation = await fs.readFile(marker(root), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (generation === head.generation && await fs.stat(root).then(s => s.isDirectory()).catch(() => false)) return true;
  const temporary = path.join(path.dirname(root), `.agent-files-${randomUUID()}`);
  await fs.mkdir(temporary, { recursive: true, mode: 0o700 });
  const signal = AbortSignal.timeout(30_000);
  try {
    // Complete and verify the replacement before discarding an older projection.
    for (const entry of head.entries) {
      signal.throwIfAborted();
      const relative = instructionPath(entry.path);
      if (entry.kind === "dir") {
        await assertInstructionPathSafe(temporary, `${relative}/.path-check`);
        await fs.mkdir(path.join(temporary, relative), { recursive: true, mode: 0o700 }); continue;
      }
      const filename = await assertInstructionPathSafe(temporary, relative);
      await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      const handle = await fs.open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, entry.mode & 0o777);
      try {
        const hash = createHash("sha256");
        let size = 0;
        if (entry.objectKey !== null) {
          const object = await service.getObject(owner.companyId, entry.objectKey, { signal });
          await pipeline(object.stream, new Transform({ transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length;
            if (size > entry.size) return callback(new Error("Agent file exceeds its committed size"));
            hash.update(chunk); callback(null, chunk);
          } }), handle.createWriteStream(), { signal });
        }
        if (size !== entry.size || hash.digest("hex") !== entry.sha256) throw new Error("Agent file does not match its committed digest");
      } finally { await handle.close(); }
    }
    await invalidateAgentFileProjection(root);
    await fs.rm(root, { recursive: true, force: true });
    await fs.rename(temporary, root);
    await mark(root, head.generation);
    return true;
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

/** Publish immutable bytes before the database head. A failed/uncertain database
 * commit never removes uploaded bytes that may have become authoritative. */
export async function persistDurableAgentFiles(tx: Tx, owner: Owner, root: string, importingLegacy = false) {
  const [previous] = await tx.select().from(agentFileRoots).where(where(owner));
  if (!previous && !durableAgentFilesEnabled()) return;
  const service = storage();
  const manifest = await cachedAgentFileManifest(root);
  if (!importingLegacy) {
    if (manifest.entries.length > MAX_AGENT_DIRECTORY_ENTRIES) throw new AgentFileLimitError("Agent directory exceeds the 100,000-entry limit (files and folders)");
    let total = 0;
    for (const [relative, entry] of manifest.entries) if (entry.kind === "file") {
      if (entry.size! > MAX_AGENT_FILE_BYTES) throw new AgentFileLimitError(`Agent file "${relative}" exceeds the 256 MiB per-file limit`);
      total += entry.size!;
    }
    if (total > MAX_AGENT_DIRECTORY_BYTES) throw new AgentFileLimitError("Agent directory exceeds the 2 GiB total storage limit");
  }
  const before = new Map(previous?.entries.map(entry => [entry.path, entry]));
  const entries: DurableAgentFileEntry[] = [];
  const signal = AbortSignal.timeout(30_000);
  for (const [relative, entry] of manifest.entries) {
    signal.throwIfAborted();
    if (entry.kind === "dir") { entries.push({ path: relative, kind: "dir" }); continue; }
    if (entry.kind !== "file") throw new Error("Agent files cannot contain symbolic links");
    if (entry.size === undefined || entry.mode === undefined || !entry.hash) throw new Error("Agent file metadata is incomplete");
    const old = before.get(relative);
    let objectKey = old?.kind === "file" && old.sha256 === entry.hash && old.size === entry.size ? old.objectKey : null;
    if (!objectKey && entry.size !== 0) {
      const filename = await assertInstructionPathSafe(root, relative);
      const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      const source = handle.createReadStream();
      const hash = createHash("sha256");
      let size = 0;
      const body = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > entry.size!) return callback(new Error("Agent file changed during upload"));
        hash.update(chunk); callback(null, chunk);
      }, flush(callback) {
        callback(size === entry.size && hash.digest("hex") === entry.hash ? null : new Error("Agent file changed during upload"));
      } });
      try {
        const [result] = await Promise.all([service.putFile({ companyId: owner.companyId, namespace: `agent-files/${owner.id}`,
          originalFilename: null, contentType: "application/octet-stream", body,
          byteSize: entry.size, sha256: entry.hash, signal }), pipeline(source, body, { signal })]);
        objectKey = result.objectKey;
      } finally { source.destroy(); body.destroy(); await handle.close(); }
    }
    entries.push({ path: relative, kind: "file", mode: entry.mode, size: entry.size, sha256: entry.hash, objectKey });
  }
  if (previous && JSON.stringify(previous.entries) === JSON.stringify(entries)) {
    await mark(root, previous.generation);
    return;
  }
  const generation = randomUUID();
  if (!previous) {
    // This is a retry receipt for the one-time local import, not serving
    // authority. Once committed, Postgres and S3 suffice without this file.
    await atomicPrivateWrite(adoptionReceipt(root), JSON.stringify({ version: 1, agentCreatedAt: owner.createdAt.toISOString(),
      head: { companyId: owner.companyId, agentId: owner.id, generation, entries } }));
  }
  await tx.insert(agentFileRoots).values({ companyId: owner.companyId, agentId: owner.id, generation, entries })
    .onConflictDoUpdate({ target: [agentFileRoots.companyId, agentFileRoots.agentId], set: { generation, entries, updatedAt: new Date() } });
  await mark(root, generation);
}
