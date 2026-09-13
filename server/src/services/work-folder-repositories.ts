import { createHash, randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { taskRepositoryBindings, workFolderObjects, type Db } from "@paperclipai/db";
import { validateWorkFilePath } from "@paperclipai/shared";
import { z } from "zod";
import { registerWorkFolderObject } from "./work-folder-garbage.js";
import type { StorageProvider } from "../storage/types.js";
import type { WorkFolderTransport, WorkTreeEntry } from "./work-folder-transport.js";

type Binding = typeof taskRepositoryBindings.$inferSelect;
const checkpointSchema = z.object({ version: z.literal(1), bindingId: z.uuid(), files: z.array(z.object({
  path: z.string(), kind: z.enum(["file", "directory"]), byteSize: z.number().int().min(0).max(1024 ** 3),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(), executable: z.boolean(), objectKey: z.string().nullable(), linkTarget: z.string().max(1024).optional(),
})).max(100_000) });

function signature(entries: WorkTreeEntry[]) {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export function workFolderRepositoryService(db: Db, storage: StorageProvider, transport: WorkFolderTransport) {
  const knownByBinding = new Map<string, Set<string>>();
  async function checkpoint(binding: Binding, root: string) {
    // Another sandbox can have published since this coordinator loaded the
    // binding. Cache only the current complete checkpoint's protected objects.
    const [current] = await db.select().from(taskRepositoryBindings).where(and(
      eq(taskRepositoryBindings.id, binding.id), eq(taskRepositoryBindings.companyId, binding.companyId)));
    if (!current) throw new Error("Repository owner was deleted during checkpoint");
    if (current.checkpointKey !== binding.checkpointKey) knownByBinding.delete(binding.id);
    Object.assign(binding, current);
    const startedAt = Date.now();
    const entries = await transport.scan(root, true);
    const digest = signature(entries);
    if (binding.checkpointSha256 === digest) return;
    const prefix = `${binding.companyId}/task-repositories/${binding.id}/`;
    if (!knownByBinding.has(binding.id) && binding.checkpointKey) await loadManifest(binding);
    const known = knownByBinding.get(binding.id) ?? new Set<string>();
    const files: Array<WorkTreeEntry & { objectKey: string | null }> = [];
    for (const entry of entries) {
      const objectKey = entry.kind === "file" && !entry.linkTarget ? `${prefix}blobs/${entry.sha256}` : null;
      if (objectKey && !known.has(objectKey)) await registerWorkFolderObject(db, storage, { objectKey, companyId: binding.companyId, repositoryBindingId: binding.id });
      if (objectKey && !known.has(objectKey) && !(await storage.headObject({ objectKey })).exists) {
        const hash = createHash("sha256");
        const verify = new Transform({ transform(chunk: Buffer, _encoding, callback) { hash.update(chunk); callback(null, chunk); },
          flush(callback) { callback(hash.digest("hex") === entry.sha256 ? undefined : new Error("Repository changed during checkpoint")); } });
        const source = transport.read(root, entry.path, entry.byteSize);
        source.on("error", (error) => verify.destroy(error));
        try {
          await storage.putObject({ objectKey, body: source.pipe(verify), contentType: "application/octet-stream", contentLength: entry.byteSize });
        } finally { source.destroy(); verify.destroy(); }
      }
      files.push({ ...entry, objectKey });
    }
    // Never publish a torn Git index/worktree snapshot as a completed save.
    if (signature(await transport.scan(root, true)) !== digest) throw new Error("Repository changed during checkpoint; retry required");
    const checkpointKey = `${prefix}checkpoints/${randomUUID()}.json`;
    const body = Buffer.from(JSON.stringify({ version: 1, bindingId: binding.id, files }));
    await registerWorkFolderObject(db, storage, { objectKey: checkpointKey, companyId: binding.companyId, repositoryBindingId: binding.id });
    await storage.putObject({ objectKey: checkpointKey, body, contentType: "application/json", contentLength: body.length });
    // Retired objects have a 24-hour grace period. A checkpoint must finish
    // within that window even when a competing run advances the pointer.
    if (Date.now() - startedAt > 60 * 60 * 1000) throw new Error("Repository checkpoint exceeded the one-hour save limit; retry required");
    await db.transaction(async (tx) => {
      const [owner] = await tx.select({ id: taskRepositoryBindings.id }).from(taskRepositoryBindings)
        .where(and(eq(taskRepositoryBindings.id, binding.id), eq(taskRepositoryBindings.companyId, binding.companyId))).for("update");
      if (!owner) throw new Error("Repository owner was deleted during checkpoint");
      // Retire superseded manifests and blobs in the same transaction that
      // protects ALL current objects and advances the complete-checkpoint pointer.
      // The grace period also lets an already-started restore finish safely.
      await tx.update(workFolderObjects).set({ deleteAfter: new Date(Date.now() + 24 * 60 * 60 * 1000) })
        .where(and(eq(workFolderObjects.repositoryBindingId, binding.id), eq(workFolderObjects.companyId, binding.companyId), isNull(workFolderObjects.deleteAfter)));
      const published = [checkpointKey, ...new Set(files.flatMap((file) => file.objectKey ? [file.objectKey] : []))];
      for (let offset = 0; offset < published.length; offset += 1000) {
        const batch = published.slice(offset, offset + 1000);
        const protectedObjects = await tx.update(workFolderObjects).set({ deleteAfter: null })
          .where(and(eq(workFolderObjects.repositoryBindingId, binding.id), inArray(workFolderObjects.objectKey, batch)))
          .returning({ key: workFolderObjects.objectKey });
        if (protectedObjects.length !== batch.length) throw new Error("Repository objects expired during checkpoint; retry required");
      }
      const updated = await tx.update(taskRepositoryBindings).set({ checkpointKey, checkpointSha256: digest, checkpointAt: new Date() })
        .where(and(eq(taskRepositoryBindings.id, binding.id), eq(taskRepositoryBindings.companyId, binding.companyId))).returning({ id: taskRepositoryBindings.id });
      if (!updated.length) throw new Error("Repository owner was deleted during checkpoint");
    });
    knownByBinding.set(binding.id, new Set(files.flatMap((file) => file.objectKey ? [file.objectKey] : [])));
    binding.checkpointKey = checkpointKey;
    binding.checkpointSha256 = digest;
  }

  async function loadManifest(binding: Binding) {
    if (!binding.checkpointKey) throw new Error("Repository checkpoint is missing");
    const prefix = `${binding.companyId}/task-repositories/${binding.id}/`;
    if (!binding.checkpointKey.startsWith(prefix)) throw new Error("Repository checkpoint ownership mismatch");
    const { stream } = await storage.getObject({ objectKey: binding.checkpointKey });
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of stream) {
      length += chunk.length;
      if (length > 64 * 1024 * 1024) { stream.destroy(); throw new Error("Repository checkpoint manifest exceeds size limit"); }
      chunks.push(Buffer.from(chunk));
    }
    const manifest = checkpointSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (manifest.bindingId !== binding.id) throw new Error("Repository checkpoint ownership mismatch");
    for (const entry of manifest.files) {
      validateWorkFilePath(entry.path);
      if (entry.objectKey && entry.objectKey !== `${prefix}blobs/${entry.sha256}`) throw new Error("Repository object ownership mismatch");
    }
    const entries = manifest.files.map(({ objectKey: _key, ...entry }) => entry);
    if (signature(entries) !== binding.checkpointSha256) throw new Error("Repository checkpoint integrity mismatch");
    knownByBinding.set(binding.id, new Set(manifest.files.flatMap((file) => file.objectKey ? [file.objectKey] : [])));
    return manifest;
  }

  async function restore(binding: Binding, root: string, stagingRoot: string) {
    if (!binding.checkpointKey) return false;
    const manifest = await loadManifest(binding);
    await transport.mkdirRoot(root);
    for (const entry of manifest.files) {
      if (entry.kind === "directory") await transport.mkdir(root, entry.path);
      else if (entry.linkTarget) await transport.symlink(root, stagingRoot, entry);
      else {
        if (!entry.objectKey) throw new Error("Repository checkpoint file is missing");
        const result = await storage.getObject({ objectKey: entry.objectKey });
        try { await transport.write(root, stagingRoot, entry, result.stream); } finally { result.stream.destroy(); }
      }
    }
    return true;
  }
  return { checkpoint, restore };
}
