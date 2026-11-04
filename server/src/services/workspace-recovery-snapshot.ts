import { z } from "zod";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { and, desc, eq, sql } from "drizzle-orm";
import { workspaceOperations, type Db } from "@paperclipai/db";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { createCommandManagedRuntimeClient } from "@paperclipai/adapter-utils/command-managed-runtime";
import { createTarballFromDirectory, exportSandboxWorkspaceSnapshot, restoreVerifiedSnapshotArchive } from "@paperclipai/adapter-utils/sandbox-managed-runtime";
import { captureDirectorySnapshotOffThread, disposeDirectorySnapshot } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { getStorageService, type StorageService } from "../storage/index.js";
import { SystemRecoveryFailure } from "./system-recovery-state.js";
import { recoveryRunAncestry } from "./recovery-run-ancestry.js";

const storedFileSchema = z.object({ objectKey: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), byteSize: z.number().int().positive() });
type StoredFile = z.infer<typeof storedFileSchema>;
const snapshotSchema = z.object({
  schema: z.literal("paperclip.workspace-recovery-snapshot.v1"), recoveryActionId: z.string().uuid(),
  leaseId: z.string().uuid(), providerLeaseId: z.string().min(1), archive: storedFileSchema, manifest: storedFileSchema,
});
export type PreservedWorkspaceSnapshot = z.infer<typeof snapshotSchema>;
export function readSnapshot(value: unknown, companyId: string, runId: string) {
  const parsed = snapshotSchema.safeParse(value);
  if (!parsed.success) throw new SystemRecoveryFailure("snapshot_verification_failed", "service_required");
  const s = parsed.data;
  const prefix = `${companyId}/workspace-recovery/${runId}/${s.leaseId}/`;
  if (s.archive.objectKey !== `${prefix}${s.archive.sha256}.tar` || s.manifest.objectKey !== `${prefix}${s.manifest.sha256}.jsonl`)
    throw new SystemRecoveryFailure("snapshot_verification_failed", "service_required");
  return s;
}

async function digest(stream: AsyncIterable<Buffer | string>, limit = Number.MAX_SAFE_INTEGER) {
  const hash = createHash("sha256");
  let byteSize = 0;
  for await (const chunk of stream) {
    byteSize += Buffer.byteLength(chunk);
    if (byteSize > limit) throw new SystemRecoveryFailure("snapshot_verification_failed", "service_required");
    hash.update(chunk);
  }
  return { sha256: hash.digest("hex"), byteSize };
}

export async function verifyStoredRecoveryFile(storage: StorageService, companyId: string, file: StoredFile) {
  const object = await storage.getObject(companyId, file.objectKey);
  try {
    const actual = await digest(object.stream, file.byteSize);
    if (actual.sha256 !== file.sha256 || actual.byteSize !== file.byteSize)
      throw new SystemRecoveryFailure("snapshot_verification_failed", "service_required");
  } finally { object.stream.destroy(); }
}

/** The durable operation is written before uploading. A lost upload reply or
 * DB commit is reconciled against that same object identity on the next pass. */
export async function preserveWorkspaceSnapshot(input: {
  db: Db; companyId: string; issueId: string; runId: string; actionId: string;
  leaseId: string; providerLeaseId: string; target: AdapterSandboxExecutionTarget;
  assertHeld(): Promise<void>;
}) {
  if (!input.target.runner) throw new SystemRecoveryFailure("source_unavailable", "service_required");
  const storage = getStorageService();
  const scope = and(eq(workspaceOperations.companyId, input.companyId),
    eq(workspaceOperations.heartbeatRunId, input.runId), eq(workspaceOperations.phase, "workspace_recovery_snapshot"),
    sql`${workspaceOperations.metadata}->>'leaseId' = ${input.leaseId}`,
    sql`${workspaceOperations.metadata}->>'providerLeaseId' = ${input.providerLeaseId}`,
    sql`${workspaceOperations.metadata}->>'recoveryActionId' = ${input.actionId}`);
  const [existing] = await input.db.select().from(workspaceOperations).where(scope)
    .orderBy(desc(workspaceOperations.createdAt)).limit(1);
  if (existing?.metadata?.schema === "paperclip.workspace-recovery-snapshot.v1") {
    const saved = readSnapshot(existing.metadata, input.companyId, input.runId);
    const heads = await Promise.all([storage.headObject(input.companyId, saved.archive.objectKey),
      storage.headObject(input.companyId, saved.manifest.objectKey)]);
    if (heads.every(head => head.exists)) {
      await verifyStoredRecoveryFile(storage, input.companyId, saved.archive);
      await verifyStoredRecoveryFile(storage, input.companyId, saved.manifest);
      await input.assertHeld();
      await input.db.update(workspaceOperations).set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(workspaceOperations.id, existing.id));
      return existing.id;
    }
    if (existing.status === "succeeded") throw new SystemRecoveryFailure("snapshot_verification_failed", "service_required");
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-preserve-"));
  try {
    await input.assertHeld();
    const client = createCommandManagedRuntimeClient({ runner: input.target.runner,
      commandCwd: input.target.remoteCwd, timeoutMs: input.target.timeoutMs ?? 120_000 });
    const directory = path.join(root, "files");
    await exportSandboxWorkspaceSnapshot({ client, remoteDir: input.target.remoteCwd,
      stagingDir: directory, operationId: `preserve:${input.actionId}:${input.leaseId}` }).catch(error => {
        if (error?.code === "WORKSPACE_SNAPSHOT_EXPORT_UNSUPPORTED")
          throw new SystemRecoveryFailure("source_unavailable", "use_alternative_strategy");
        throw error;
      });
    await input.assertHeld();
    const manifestPath = path.join(root, "manifest.jsonl");
    const snapshot = await captureDirectorySnapshotOffThread(directory, { exclude: [], diskBacked: true });
    try {
      await pipeline(Readable.from((function* () {
        yield `${JSON.stringify({ schema: "paperclip.workspace-file-manifest.v1" })}\n`;
        for (const entry of snapshot.entries) yield `${JSON.stringify(entry)}\n`;
      })()), createWriteStream(manifestPath, { flags: "wx", mode: 0o600 }));
    } finally { await disposeDirectorySnapshot(snapshot); }
    const archivePath = path.join(root, "workspace.tar");
    await createTarballFromDirectory({ localDir: directory, archivePath });
    const files = await Promise.all([archivePath, manifestPath].map(async file => ({
      ...await digest(createReadStream(file)), file,
    })));
    const prefix = `${input.companyId}/workspace-recovery/${input.runId}/${input.leaseId}`;
    const stored = files.map((file, index) => ({ objectKey: `${prefix}/${file.sha256}.${index === 0 ? "tar" : "jsonl"}`,
      sha256: file.sha256, byteSize: file.byteSize }));
    const metadata: PreservedWorkspaceSnapshot = { schema: "paperclip.workspace-recovery-snapshot.v1",
      recoveryActionId: input.actionId, leaseId: input.leaseId, providerLeaseId: input.providerLeaseId,
      archive: stored[0], manifest: stored[1] };
    await input.assertHeld();
    const [operation] = existing
      ? await input.db.update(workspaceOperations).set({ metadata, status: "running", updatedAt: new Date() })
          .where(eq(workspaceOperations.id, existing.id)).returning()
      : await input.db.insert(workspaceOperations).values({ companyId: input.companyId, issueId: input.issueId,
          heartbeatRunId: input.runId, phase: "workspace_recovery_snapshot", status: "running", metadata }).returning();
    for (const [index, file] of files.entries()) {
      if (!(await storage.headObject(input.companyId, stored[index].objectKey)).exists) {
        if ((await stat(file.file)).size === 0) {
          throw new SystemRecoveryFailure("snapshot_verification_failed", "service_required");
        }
        await storage.putFile({ companyId: input.companyId, namespace: "workspace-recovery",
          originalFilename: path.basename(file.file), contentType: index === 0 ? "application/x-tar" : "application/x-ndjson",
          objectKey: stored[index].objectKey, body: createReadStream(file.file), sha256: file.sha256, byteSize: file.byteSize });
      }
      await verifyStoredRecoveryFile(storage, input.companyId, stored[index]);
    }
    await input.assertHeld();
    await input.db.update(workspaceOperations).set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(workspaceOperations.id, operation.id));
    return operation.id;
  } finally { await rm(root, { recursive: true, force: true }); }
}

/** Recovered files are an attachment to a fresh attempt, never an overlay.
 * Atomically publish each immutable snapshot directory after verification. */
export async function attachPreservedWorkspaceSnapshots(input: {
  db: Db; companyId: string; issueId: string; sourceRunIds: string[]; cwd: string;
}) {
  const storage = getStorageService();
  const results: Array<{ operationId: string; path: string; sourceRunId: string }> = [];
  const sources = await recoveryRunAncestry(input);
  for (const { id: sourceRunId } of sources) {
    const rows = await input.db.select().from(workspaceOperations).where(and(
      eq(workspaceOperations.companyId, input.companyId), eq(workspaceOperations.issueId, input.issueId),
      eq(workspaceOperations.heartbeatRunId, sourceRunId), eq(workspaceOperations.phase, "workspace_recovery_snapshot"),
      eq(workspaceOperations.status, "succeeded")));
    for (const operation of rows) {
      const saved = readSnapshot(operation.metadata, input.companyId, sourceRunId);
      const parent = path.join(await realpath(input.cwd), ".paperclip-recovered");
      await mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
      if ((await lstat(parent)).isSymbolicLink() || await realpath(parent) !== parent)
        throw new SystemRecoveryFailure("snapshot_verification_failed", "service_required");
      const destination = path.join(parent, operation.id);
      const provenance = { schema: saved.schema, operationId: operation.id, sourceRunId,
        leaseId: saved.leaseId, sha256: saved.archive.sha256 };
      const priorStat = await lstat(destination).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; });
      if (priorStat && (!priorStat.isDirectory() || priorStat.isSymbolicLink() || await realpath(destination) !== destination))
        throw new SystemRecoveryFailure("snapshot_verification_failed", "service_required");
      const provenancePath = path.join(destination, "provenance.json");
      if (priorStat) {
        const proof = await lstat(provenancePath).catch(() => null);
        if (!proof?.isFile() || proof.isSymbolicLink())
          throw new SystemRecoveryFailure("snapshot_verification_failed", "service_required");
      }
      const prior = priorStat ? await readFile(provenancePath, "utf8").catch(() => null) : null;
      if (prior === JSON.stringify(provenance)) {
        results.push({ operationId: operation.id, path: destination, sourceRunId });
        continue;
      }
      if (priorStat) throw new SystemRecoveryFailure("snapshot_verification_failed", "service_required");
      await verifyStoredRecoveryFile(storage, input.companyId, saved.manifest);
      const staging = await mkdtemp(path.join(parent, ".preparing-"));
      try {
        const archivePath = path.join(staging, "snapshot.tar");
        const object = await storage.getObject(input.companyId, saved.archive.objectKey);
        try { await pipeline(object.stream, createWriteStream(archivePath, { flags: "wx", mode: 0o600 })); }
        finally { object.stream.destroy(); }
        await restoreVerifiedSnapshotArchive({ archivePath, localDir: path.join(staging, "files"), ...saved.archive });
        await rm(archivePath);
        await writeFile(path.join(staging, "provenance.json"), JSON.stringify(provenance), { flag: "wx", mode: 0o600 });
        // Never replace an earlier attachment or user edits on a restart.
        await rename(staging, destination);
        results.push({ operationId: operation.id, path: destination, sourceRunId });
      } finally { await rm(staging, { recursive: true, force: true }); }
    }
  }
  return results;
}
