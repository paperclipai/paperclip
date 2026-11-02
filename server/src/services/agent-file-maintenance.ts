import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { agentFileRoots, agents, fileStorageDb, heartbeatRuns, type Db } from "@paperclipai/db";
import type { StorageProvider, StorageService } from "../storage/types.js";
import { adoptAgentFiles, inspectAgentDirectory } from "./agent-file-store.js";
import { agentInstructionsBundleMode, deriveBundleState, resolveManagedInstructionsRoot } from "./agent-instructions.js";
import { durableAgentFilesEnabled } from "./agent-file-durability.js";

export const AGENT_FILE_OBJECT_GRACE_MS = 30 * 24 * 60 * 60_000;

/** One-time operator migration on the host that owns the volume. Cloud must
 * stop ingress and execution writers before apply; row locks also serialize
 * ordinary file mutations. A dry run never adopts or rewrites local files. */
export async function migrateAgentFiles(db: Db, input: {
  apply: boolean; writersStopped: boolean; companyId?: string; after?: string; limit?: number;
}) {
  if (input.apply && (!input.writersStopped || !durableAgentFilesEnabled())) {
    throw new Error("Agent file migration requires stopped writers and PAPERCLIP_DURABLE_AGENT_FILES=true");
  }
  const limit = input.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Migration limit must be between 1 and 100");
  const rows = await db.select({ id: agents.id }).from(agents).where(and(
    input.companyId ? eq(agents.companyId, input.companyId) : undefined,
    input.after ? gt(agents.id, input.after) : undefined,
  )).orderBy(asc(agents.id)).limit(limit + 1);
  const results: Array<{ agentId: string; state: string }> = [];
  for (const candidate of rows.slice(0, limit)) {
    const state = await fileStorageDb(db).transaction(async tx => {
      const [agent] = await tx.select().from(agents).where(eq(agents.id, candidate.id)).for("update");
      if (!agent) return "removed";
      if (agentInstructionsBundleMode(agent) === "external") return "external_instructions";
      const [run] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.agentId, agent.id),
        inArray(heartbeatRuns.status, ["running", "queued"]),
      )).limit(1);
      if (run) return "active_execution";
      const [head] = await tx.select({ generation: agentFileRoots.generation }).from(agentFileRoots)
        .where(and(eq(agentFileRoots.companyId, agent.companyId), eq(agentFileRoots.agentId, agent.id)));
      if (input.apply) {
        await adoptAgentFiles(tx, agent);
        return "durable";
      }
      if (head) return "durable";
      const root = resolveManagedInstructionsRoot(agent);
      const stored = agent.adapterConfig.instructionsRootPath;
      if (typeof stored === "string" && (path.resolve(stored) !== root
        || !await fs.stat(path.join(root, deriveBundleState(agent).entryFile)).then(s => s.isFile()).catch(() => false))) {
        return "legacy_files_missing";
      }
      if (await fs.stat(root).then(s => s.isDirectory()).catch(() => false)) await inspectAgentDirectory(root, false);
      return "needs_import";
    });
    results.push({ agentId: candidate.id, state });
  }
  return { results, next: rows.length > limit ? results.at(-1)!.agentId : null,
    pageReady: results.every(row => row.state === "durable" || row.state === "removed") };
}

/** Bounded, explicit maintenance, with no idle polling. Keep every object for
 * an unadopted agent: a rolled-back first save may have a local import receipt.
 * The agent row lock prevents a concurrent publisher from reusing an object
 * between the current-head check and deletion. Deleted agents have no writer. */
export async function collectAgentFileObjects(db: Db, provider: Pick<StorageProvider, "id" | "listObjects">, storage: StorageService, input: {
  companyId: string; agentId: string; apply: boolean; continuationToken?: string; now?: number;
}) {
  if (provider.id !== "s3" || storage.provider !== "s3" || !provider.listObjects) throw new Error("Shared object storage is required");
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (!uuid.test(input.companyId) || !uuid.test(input.agentId)) throw new Error("Company and agent UUIDs are required");
  const prefix = `${input.companyId}/agent-files/${input.agentId}/`;
  const signal = AbortSignal.timeout(30_000);
  const page = await provider.listObjects({ prefix, continuationToken: input.continuationToken, signal });
  let retained = 0, eligible = 0, deleted = 0;
  for (const key of page.keys) {
    signal.throwIfAborted();
    if (!key.startsWith(prefix) || key.includes("..") || key.includes("\\")) throw new Error("Agent file object scope is invalid");
    await fileStorageDb(db).transaction(async tx => {
      const [agent] = await tx.select({ id: agents.id }).from(agents)
        .where(and(eq(agents.companyId, input.companyId), eq(agents.id, input.agentId))).for("update");
      const [head] = await tx.select({ entries: agentFileRoots.entries }).from(agentFileRoots)
        .where(and(eq(agentFileRoots.companyId, input.companyId), eq(agentFileRoots.agentId, input.agentId)));
      if ((agent && !head) || head?.entries.some(entry => entry.kind === "file" && entry.objectKey === key)) {
        retained++; return;
      }
      const object = await storage.headObject(input.companyId, key, { signal });
      if (!object.exists || !object.lastModified || object.lastModified.getTime() + AGENT_FILE_OBJECT_GRACE_MS > (input.now ?? Date.now())) {
        retained++; return;
      }
      eligible++;
      if (input.apply) {
        await storage.deleteObject(input.companyId, key, { signal, allVersions: true });
        if ((await storage.headObject(input.companyId, key, { signal })).exists) throw new Error("Agent file object remains after deletion");
        deleted++;
      }
    });
  }
  return { retained, eligible, deleted, next: page.continuationToken ?? null };
}

/** Verify all authoritative bytes before the legacy volume can be detached.
 * This runs only with writers stopped, using bounded pages and streams. */
export async function verifyAgentFileObjects(db: Db, storage: StorageService, signal: AbortSignal): Promise<number> {
  if (storage.provider !== "s3") throw new Error("shared_object_storage_required");
  let after: string | undefined;
  let verified = 0;
  for (;;) {
    signal.throwIfAborted();
    const heads = await db.select().from(agentFileRoots).where(after ? gt(agentFileRoots.agentId, after) : undefined)
      .orderBy(asc(agentFileRoots.agentId)).limit(25);
    for (const head of heads) for (const file of head.entries) {
      if (file.kind !== "file") continue;
      const hash = createHash("sha256");
      let bytes = 0;
      if (file.objectKey !== null) {
        const object = await storage.getObject(head.companyId, file.objectKey, { signal });
        for await (const chunk of object.stream) {
          signal.throwIfAborted(); bytes += chunk.length;
          if (bytes > file.size) throw new Error("agent_file_object_size_mismatch");
          hash.update(chunk);
        }
      }
      if (bytes !== file.size || hash.digest("hex") !== file.sha256) throw new Error("agent_file_object_digest_mismatch");
      verified++;
    }
    if (heads.length < 25) break;
    after = heads.at(-1)!.agentId;
  }
  return verified;
}
