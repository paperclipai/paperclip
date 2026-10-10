import { persistentAgentFiles, readPersistentAgentFile, seedPersistentAgentHome } from "./persistent-agent-files.js";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { cachedAgentFileManifest, checkpointSnapshot, type AgentFileManifest } from "./agent-file-checkpoints.js";
import { constants } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { agents, activityLog, agentInstructionHeads, agentInstructionRevisions, type Db } from "@paperclipai/db";
import { captureDirectorySnapshot, mergeDirectoryWithBaseline, type DirectorySnapshot } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { HttpError, conflict, notFound, unprocessable } from "../errors.js";
import { authorizeInstructionCommit, authorizeInstructionRead } from "./agent-instruction-authorization.js";
import { assertInstructionPathSafe, instructionPath, instructionBytes, materializeInstructionBytes, readInstructionBytes, MAX_INSTRUCTION_BYTES } from "./agent-instruction-files.js";
import { agentInstructionsBundleMode, deriveBundleState, resolveManagedInstructionsRoot } from "./agent-instructions.js";
import type { AuthorizationActor } from "./authorization.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Agent = typeof agents.$inferSelect;
export const AGENT_FILES_CONTRACT = "paperclip.agent-files.v1";
export const MAX_AGENT_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_AGENT_DIRECTORY_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_AGENT_DIRECTORY_ENTRIES = 100_000;
export const fileHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export class AgentFileLimitError extends HttpError {
  constructor(message: string) {
    super(422, message, { code: "AGENT_FILES_LIMIT_EXCEEDED" });
  }
}
function assertFileSize(size: number, relative: string) {
  if (size > MAX_AGENT_FILE_BYTES) throw new AgentFileLimitError(`Agent file "${relative}" exceeds the 256 MiB per-file limit`);
}
function assertDirectorySize(size: number, count: number) {
  if (size > MAX_AGENT_DIRECTORY_BYTES) throw new AgentFileLimitError("Agent directory exceeds the 2 GiB total storage limit");
  if (count > MAX_AGENT_DIRECTORY_ENTRIES) throw new AgentFileLimitError("Agent directory exceeds the 100,000-entry limit (files and folders)");
}
export function agentStorageWarning(detail: string) {
  return `Agent storage is full. ${detail}. Runs can continue; remove or shrink files in AGENT_HOME to free space. Changes exceeding the storage limits will not be saved.`;
}
function storageWarning(size: number, count: number, fullFile?: string) {
  if (size >= MAX_AGENT_DIRECTORY_BYTES) return agentStorageWarning("The agent folder has reached its 2 GiB limit");
  if (count >= MAX_AGENT_DIRECTORY_ENTRIES) return agentStorageWarning("The agent folder has reached its 100,000-entry limit");
  if (fullFile) return agentStorageWarning(`Agent file "${fullFile}" has reached its 256 MiB limit`);
  return null;
}

export function agentFilePath(value: string): string {
  const relative = instructionPath(value);
  if (relative.split("/").includes(".paperclip-runtime") || relative === "promptTemplate.legacy.md") {
    throw unprocessable(`${relative} is reserved and cannot be used for agent files`);
  }
  return relative;
}

/** Compatibility ETag for clients whose old schema requires a UUID. This is a
 * content token, not a revision ID: no snapshot or history row is created. */
export function agentFileToken(bytes: Uint8Array): string {
  return agentFileTokenFromHash(fileHash(bytes));
}
export function agentFileTokenFromHash(h: string): string {
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Call under the agent row lock. Import deployed revision heads once, then the
 * directory is authoritative. The adoption marker lives OUTSIDE agent files. */
export async function adoptAgentFiles(tx: Tx, agent: Agent): Promise<string> {
  if (agentInstructionsBundleMode(agent) === "external") throw unprocessable("External instructions must be migrated to managed storage first");
  const root = resolveManagedInstructionsRoot(agent);
  const markerRoot = path.join(path.dirname(root), "file-sync");
  const marker = "adopted.json";
  await assertInstructionPathSafe(root, deriveBundleState(agent).entryFile);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const filename = await assertInstructionPathSafe(markerRoot, marker);
  const adopted = await fs.readFile(filename, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (adopted !== null) {
    if (JSON.parse(adopted).schema !== AGENT_FILES_CONTRACT) throw new Error("Unsupported agent file contract");
    return root;
  }
  const legacy = await tx.select({ entryFile: agentInstructionHeads.entryFile, contentBase64: agentInstructionRevisions.contentBase64 })
    .from(agentInstructionHeads).innerJoin(agentInstructionRevisions, eq(agentInstructionHeads.revisionId, agentInstructionRevisions.id))
    .where(and(eq(agentInstructionHeads.companyId, agent.companyId), eq(agentInstructionHeads.agentId, agent.id)));
  for (const entry of legacy) await materializeInstructionBytes(root, entry.entryFile, Buffer.from(entry.contentBase64, "base64"));
  await materializeInstructionBytes(markerRoot, marker, Buffer.from(JSON.stringify({ schema: AGENT_FILES_CONTRACT })));
  return root;
}

async function openAgentFile(root: string, relative: string) {
  const filename = await assertInstructionPathSafe(root, relative);
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!handle) return null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw unprocessable("Agent files must be regular files without links");
    assertFileSize(stat.size, relative);
    return { handle, size: stat.size };
  } catch (error) { await handle.close(); throw error; }
}

/** Hash large files incrementally. Only editor-sized content is retained in RAM. */
export async function inspectAgentFile(root: string, relative: string, bufferLimit = MAX_INSTRUCTION_BYTES) {
  const opened = await openAgentFile(root, relative);
  if (!opened) return null;
  const hash = createHash("sha256");
  let chunks: Buffer[] | null = opened.size <= bufferLimit ? [] : null;
  let size = 0;
  try {
    for await (const chunk of opened.handle.createReadStream()) {
      size += chunk.length;
      assertFileSize(size, relative);
      hash.update(chunk);
      if (size > bufferLimit) chunks = null;
      chunks?.push(chunk);
    }
    return { size, hash: hash.digest("hex"), bytes: chunks ? Buffer.concat(chunks) : null };
  } finally { await opened.handle.close(); }
}

export async function readAgentFile(root: string, relative: string): Promise<Buffer | null> {
  return (await inspectAgentFile(root, relative, MAX_AGENT_FILE_BYTES))?.bytes ?? null;
}

/** Validate before staging and again after provider stop; never follow links or
 * silently skip an unsupported file. Bounds apply to bytes, including binaries. */
async function scanAgentFiles(root: string, enforceLimits = true) {
  await assertInstructionPathSafe(root, ".path-check");
  let size = 0, count = 0;
  const entries = new Set<string>();
  let fullFile: string | undefined;
  async function walk(dir: string) {
    for (const item of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
      const relative = agentFilePath(dir ? `${dir}/${item.name}` : item.name);
      const stat = await fs.lstat(path.join(root, relative));
      count++;
      if (enforceLimits) assertDirectorySize(size, count);
      entries.add(relative);
      if (stat.isDirectory()) await walk(relative);
      else if (stat.isFile() && stat.nlink === 1) {
        size += stat.size;
        if (stat.size >= MAX_AGENT_FILE_BYTES) fullFile ??= relative;
        if (enforceLimits) {
          assertFileSize(stat.size, relative);
          assertDirectorySize(size, count);
        }
      } else throw unprocessable("Agent directories support regular files and directories, without links or special files");
    }
  }
  await walk("");
  return { size, entries, storageWarning: storageWarning(size, count, fullFile) };
}

export async function inspectAgentDirectory(root: string, enforceLimits = true) {
  const usage = await scanAgentFiles(root, enforceLimits);
  return { snapshot: await captureDirectorySnapshot(root), storageWarning: usage.storageWarning };
}
export async function snapshotAgentFiles(root: string, enforceLimits = true): Promise<DirectorySnapshot> {
  return (await inspectAgentDirectory(root, enforceLimits)).snapshot;
}

/** Realize personal authority before any remote command needs it as cwd.
 * This is runtime setup, not a working-copy checkout: no run receipt or copyback
 * is created, and an existing remote home is always adopted untouched. */
export async function preparePersistentAgentExecutionHome(db: Db, input: {
  companyId: string; agentId: string; target?: AdapterExecutionTarget | null;
}): Promise<string | null> {
  const target = input.target;
  if (target?.kind !== "remote" || target.transport !== "computer") return null;
  if (!target.environmentId) throw conflict("Persistent agent environment is missing");
  return db.transaction(async tx => {
    const [agent] = await tx.select().from(agents)
      .where(and(eq(agents.companyId, input.companyId), eq(agents.id, input.agentId))).for("update");
    if (!agent) throw notFound("Agent not found");
    const remote = await persistentAgentFiles(db, input.companyId, input.agentId, target.environmentId!);
    if (!remote || remote.root !== target.fileAuthority.agentHome) throw conflict("Persistent agent placement changed");
    if (agentInstructionsBundleMode(agent) === "managed") {
      await seedPersistentAgentHome(remote, await adoptAgentFiles(tx, agent));
    } else {
      // An external instruction path is not an authority for personal files.
      // The seed primitive atomically creates an absent home or adopts it.
      await remote.seedBytes({});
    }
    return remote.root;
  });
}

export function agentFileStore(db: Db) {
  async function locked<T>(companyId: string, agentId: string, actor: AuthorizationActor, write: boolean,
    fn: (tx: Tx, agent: Agent, root: string, bound: AuthorizationActor, remote: Awaited<ReturnType<typeof persistentAgentFiles>>) => Promise<T>) {
    return db.transaction(async tx => {
      const [agent] = await tx.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, agentId))).for("update");
      if (!agent) throw notFound("Agent not found");
      const bound = write ? await authorizeInstructionCommit(tx, actor, agent) : await authorizeInstructionRead(tx, actor, agent);
      const root = await adoptAgentFiles(tx, agent);
      const remote = await persistentAgentFiles(db, companyId, agentId);
      if (remote) await seedPersistentAgentHome(remote, root);
      return fn(tx, agent, root, bound, remote);
    });
  }
  async function audit(tx: Tx, agent: Agent, actor: AuthorizationActor, details: Record<string, unknown>) {
    await tx.insert(activityLog).values({ companyId: agent.companyId, actorType: actor.type === "board" ? "user" : "agent",
      actorId: (actor.type === "board" ? actor.userId : actor.agentId)!, agentId: actor.type === "agent" ? actor.agentId : null,
      runId: actor.runId, responsibleUserId: actor.type === "board" ? actor.userId : actor.onBehalfOfUserId,
      action: "agent.files_updated", entityType: "agent", entityId: agent.id, details });
  }
  return {
    locked,
    download: async (companyId: string, agentId: string, relative: string, actor: AuthorizationActor) => {
      const opened: { file: Awaited<ReturnType<typeof openAgentFile>> } = { file: null };
      try {
        const file = await locked(companyId, agentId, actor, false, async (_tx, _agent, root, _bound, remote) => {
          if (remote) return { remote: await readPersistentAgentFile(remote, relative) };
          opened.file = await openAgentFile(root, instructionPath(relative));
          return opened.file;
        });
        // Transfer outside the database lock. The open descriptor pins the file
        // across concurrent atomic replacements; end bounds concurrent growth.
        if (!file) return null;
        if ("remote" in file) return file.remote ? { size: file.remote.bytes.length, stream: Readable.from([file.remote.bytes]) } : null;
        if (file.size === 0) { await file.handle.close(); return { size: 0, stream: Readable.from([]) }; }
        return { size: file.size, stream: file.handle.createReadStream({ end: file.size - 1 }) };
      } catch (error) { await opened.file?.handle.close(); throw error; }
    },
    read: (companyId: string, agentId: string, relative: string, actor: AuthorizationActor) =>
      locked(companyId, agentId, actor, false, async (_tx, _agent, root, _bound, remote) => remote ? (await readPersistentAgentFile(remote, relative))?.bytes ?? null : readAgentFile(root, instructionPath(relative))),
    write: (input: { companyId: string; agentId: string; path: string; bytes: Buffer | null; baseHash: string | null }, actor: AuthorizationActor) =>
      locked(input.companyId, input.agentId, actor, true, async (tx, agent, root, bound, remote) => {
        const relative = agentFilePath(input.path);
        if (input.bytes) assertFileSize(input.bytes.length, relative);
        const remotePrevious = remote ? await readPersistentAgentFile(remote, relative) : null;
        const previous = remote ? (remotePrevious ? { hash: remotePrevious.sha256, size: remotePrevious.bytes.length } : null) : await inspectAgentFile(root, relative);
        const currentHash = previous?.hash ?? null;
        const incomingHash = input.bytes === null ? null : fileHash(input.bytes);
        if (currentHash === incomingHash) return { contentHash: currentHash, changed: false };
        if (currentHash !== input.baseHash) throw conflict("This file changed since it was read. Reload before saving.", { code: "AGENT_FILE_CONFLICT", path: relative, currentHash });
        if (input.bytes === null && relative === deriveBundleState(agent).entryFile) throw unprocessable("The configured instruction entry cannot be deleted");
        if (remote) {
          if (input.bytes !== null && relative === deriveBundleState(agent).entryFile) instructionBytes(input.bytes);
          // The remote operation checks the hash again immediately before atomic
          // replacement. Arbitrary shell writers do not participate in this lock.
          if (input.bytes === null) await remote.remove(relative, currentHash!);
          else await remote.writeBytes(relative, input.bytes, input.baseHash);
          await audit(tx, agent, bound, { path: relative, contentHash: incomingHash });
          return { contentHash: incomingHash, changed: true };
        }
        if (input.bytes !== null) {
          if (relative === deriveBundleState(agent).entryFile) instructionBytes(input.bytes);
          // A quota check needs metadata only. Do not hash unrelated large
          // files while holding the editor's row lock for a one-file save.
          const snapshot = await scanAgentFiles(root);
          const total = snapshot.size + input.bytes.length - (previous?.size ?? 0);
          const newEntries = relative.split("/").map((_part, i, parts) => parts.slice(0, i + 1).join("/")).filter(name => !snapshot.entries.has(name)).length;
          assertDirectorySize(total, snapshot.entries.size + newEntries);
        }
        if (input.bytes === null) await fs.unlink(await assertInstructionPathSafe(root, relative));
        else await materializeInstructionBytes(root, relative, input.bytes);
        await audit(tx, agent, bound, { path: relative, contentHash: incomingHash });
        return { contentHash: incomingHash, changed: true };
      }),
    apply: (input: { companyId: string; agentId: string; sourceDir: string; baseline: DirectorySnapshot; checkpoint?: AgentFileManifest }, actor: AuthorizationActor) =>
      locked(input.companyId, input.agentId, actor, true, async (tx, agent, root, bound, remote) => {
        if (remote) throw unprocessable("Persistent remote agent files cannot accept controller copy-back");
        const incoming = input.checkpoint ? checkpointSnapshot(input.checkpoint) : await snapshotAgentFiles(input.sourceDir);
        const entryPath = deriveBundleState(agent).entryFile;
        if (incoming.entries.get(entryPath)?.kind !== "file") throw unprocessable("The configured instruction entry cannot be deleted");
        if (!input.checkpoint || JSON.stringify(incoming.entries.get(entryPath)) !== JSON.stringify(input.baseline.entries.get(entryPath))) {
          const entry = await readInstructionBytes(input.sourceDir, entryPath);
          if (entry === null) throw unprocessable("The configured instruction entry cannot be deleted");
          instructionBytes(entry);
        }
        // Previously saved/imported bytes must remain readable, including when
        // over quota. Enforce limits on the incoming and resulting tree so a
        // run can delete files to recover instead of being locked out forever.
        const current = input.checkpoint ? checkpointSnapshot(await cachedAgentFileManifest(root)) : await snapshotAgentFiles(root, false);
        // Rebase only the run's changed paths onto the current tree. This makes
        // same-file edits/deletions last-sync-wins while untouched files retain
        // changes from other runs. Ancestors may need recreating after a writer
        // replaced a directory with a file.
        const entries = new Map(input.baseline.entries);
        const changed = [...new Set([...input.baseline.entries, ...incoming.entries].map(([name]) => name))]
          .filter(name => JSON.stringify(input.baseline.entries.get(name)) !== JSON.stringify(incoming.entries.get(name)));
        for (const name of changed) {
          const present = current.entries.get(name);
          if (present) entries.set(name, present); else entries.delete(name);
          if (incoming.entries.has(name)) {
            for (let parent = path.posix.dirname(name); parent !== "."; parent = path.posix.dirname(parent)) {
              if (current.entries.get(parent)?.kind === "dir") continue;
              const before = current.entries.get(parent);
              if (before) entries.set(parent, before); else entries.delete(parent);
            }
          }
        }
        const applyBaseline = { ...input.baseline, entries };
        const finalEntries = new Map([...current.entries].map(([name, value]) => [name, { value, root }]));
        for (const name of changed) if (!incoming.entries.has(name)) finalEntries.delete(name);
        for (const [name, value] of incoming.entries) {
          if (JSON.stringify(input.baseline.entries.get(name)) === JSON.stringify(value)) continue;
          if (value.kind !== "dir") for (const child of finalEntries.keys()) if (child.startsWith(`${name}/`)) finalEntries.delete(child);
          finalEntries.set(name, { value, root: input.sourceDir });
          for (let parent = path.posix.dirname(name); parent !== "."; parent = path.posix.dirname(parent)) {
            if (finalEntries.get(parent)?.value.kind !== "dir") finalEntries.set(parent, { value: { kind: "dir" }, root: input.sourceDir });
          }
        }
        // An unchanged file created by another run can keep a removed folder
        // alive. Count those surviving parent directories in quota preflight.
        for (const name of finalEntries.keys()) {
          for (let parent = path.posix.dirname(name); parent !== "."; parent = path.posix.dirname(parent)) {
            if (!finalEntries.has(parent)) finalEntries.set(parent, { value: { kind: "dir" }, root });
          }
        }
        let total = 0;
        let fullFile: string | undefined;
        for (const [name, item] of finalEntries) if (item.value.kind === "file") {
          const size = (await fs.stat(path.join(item.root, name))).size;
          assertFileSize(size, name);
          if (size >= MAX_AGENT_FILE_BYTES) fullFile ??= name;
          total += size;
        }
        assertDirectorySize(total, finalEntries.size);
        await mergeDirectoryWithBaseline({ ...input, baseline: applyBaseline, targetDir: root,
          ...(input.checkpoint ? { snapshots: { source: incoming, current } } : {}) });
        await audit(tx, agent, bound, { sourceRunId: actor.runId, contract: AGENT_FILES_CONTRACT });
        return { storageWarning: storageWarning(total, finalEntries.size, fullFile) };
      }),
  };
}
