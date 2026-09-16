import { Router } from "express";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type Db, workFolderRuns, heartbeatRuns } from "@paperclipai/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { WORK_FOLDER_SCOPES, WORK_FOLDER_ROUTE_PATH } from "@paperclipai/shared";
import { loadConfig } from "../config.js";
import { createStorageProviderFromConfig } from "../storage/provider-registry.js";
import type { StorageProvider } from "../storage/types.js";
import { assertWorkFolderAccess } from "../services/work-folder-access.js";
import { workFolderService } from "../services/work-folders.js";
import { logActivity } from "../services/activity-log.js";
import { getActorInfo } from "./authz.js";
import { badRequest, conflict, notFound } from "../errors.js";

const ownerSchema = z.object({ companyId: z.uuid(), scope: z.enum(WORK_FOLDER_SCOPES), ownerId: z.string().min(1).max(256) })
  .refine((v) => v.scope === "user" || z.uuid().safeParse(v.ownerId).success, "Invalid folder owner");
const querySchema = z.object({ path: z.string().optional(), trash: z.enum(["true", "false"]).optional(),
  cursor: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(1000).optional() });

export function workFolderRoutes(db: Db, provider?: StorageProvider) {
  const router = Router();
  // Resolve once, lazily after authorization. Loading config probes the host
  // synchronously; repeating that for every file poll stalls unrelated requests.
  let storage = provider;
  const service = () => workFolderService(db, storage ??= createStorageProviderFromConfig(loadConfig()));
  const base = WORK_FOLDER_ROUTE_PATH;
  router.use(base, async (req, _res, next) => {
    const owner = ownerSchema.parse(req.params);
    await assertWorkFolderAccess(db, req.actor, owner, !["GET", "HEAD"].includes(req.method));
    next();
  });
  router.get(base, async (req, res) => {
    const svc = service();
    const folder = await svc.ensure(ownerSchema.parse(req.params));
    const query = querySchema.parse(req.query);
    res.json(await svc.list(folder, { trash: query.trash === "true", cursor: query.cursor, limit: query.limit }));
  });
  router.get(`${base}/content`, async (req, res) => {
    const svc = service();
    const folder = await svc.ensure(ownerSchema.parse(req.params));
    const filePath = z.string().parse(req.query.path);
    const result = await svc.content(folder, filePath);
    res.set({ "Content-Type": result.file.contentType, "Content-Length": String(result.file.byteSize),
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filePath.split("/").at(-1)!)}` });
    await pipeline(result.stream, res);
  });
  router.put(`${base}/content`, async (req, res) => {
    const svc = service();
    const folder = await svc.ensure(ownerSchema.parse(req.params));
    const filePath = z.string().parse(req.query.path);
    // Use octet-stream so Express's global JSON parser cannot consume file bytes.
    if (req.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/octet-stream") throw badRequest("Upload files as application/octet-stream");
    const result = await svc.write(folder, { path: filePath, body: req as Readable,
      contentType: z.string().max(256).parse(req.get("X-File-Content-Type") ?? "application/octet-stream"),
      executable: req.get("X-File-Executable") === "true", operationId: req.get("Idempotency-Key") ?? randomUUID() });
    if (result.applied) await audit(req, folder, "write", { path: filePath });
    res.json(result);
  });
  router.post(`${base}/operations`, async (req, res) => {
    const svc = service();
    const folder = await svc.ensure(ownerSchema.parse(req.params));
    const input = z.discriminatedUnion("action", [
      z.object({ action: z.literal("mkdir"), path: z.string() }),
      z.object({ action: z.literal("delete"), path: z.string() }),
      z.object({ action: z.literal("restore"), fileId: z.uuid() }),
      z.object({ action: z.literal("purge"), fileId: z.uuid() }),
    ]).parse(req.body);
    const operationId = req.get("Idempotency-Key") ?? randomUUID();
    const result = input.action === "purge" ? await svc.purge(folder, input.fileId, operationId)
      : input.action === "restore" ? await svc.restore(folder, input.fileId, operationId)
      : input.action === "delete" ? await svc.remove(folder, input.path, operationId)
        : await svc.write(folder, { path: input.path, kind: "directory", operationId });
    if (result.applied) await audit(req, folder, input.action, input);
    res.json({ applied: result.applied });
  });
  router.get(`${base}/sync`, async (req, res) => {
    const owner = ownerSchema.parse(req.params);
    const folder = await service().ensure(owner);
    const rows = await db.select({ folderRun: workFolderRuns, status: heartbeatRuns.status }).from(workFolderRuns)
      .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, workFolderRuns.runId))
      .where(and(eq(workFolderRuns.companyId, owner.companyId),
        sql`${workFolderRuns.manifest}->'folders'->>${owner.scope} = ${folder.id}`))
      .orderBy(desc(workFolderRuns.updatedAt)).limit(100);
    const isActive = (status: string) => status === "running" || status === "queued";
    const latestCheckpoint = rows.filter(({ folderRun, status }) =>
      !isActive(status) && folderRun.lastSavedAt !== null)
      .sort((a, b) => b.folderRun.lastSavedAt!.getTime() - a.folderRun.lastSavedAt!.getTime())[0];
    const projectStatus = ({ folderRun: row, status }: typeof rows[number]) => {
      const active = isActive(status);
      const interrupted = !active && (row.state === "starting" || row.state === "saving");
      return { runId: row.runId, agentId: row.manifest.agentId, state: interrupted ? "failed" : row.state,
        lastSavedAt: row.lastSavedAt, error: interrupted ? row.error ?? "Run ended before its final file save completed." : row.error,
        finalCheckpointAt: row.manifest.finalCheckpointAt ?? null,
        refreshRequested: row.refreshRequested, active };
    };
    const leases = new Set<string>();
    const statuses = rows.flatMap((entry) => {
      const row = entry.folderRun;
      if (leases.has(row.manifest.sandboxKey)) return [];
      // A newer successful save on this sandbox resolves its older failure,
      // even when another sandbox owns the folder's latest checkpoint. Mark
      // it represented before omitting redundant successful status rows.
      leases.add(row.manifest.sandboxKey);
      if (!isActive(entry.status) && row.state === "saved" && row.runId !== latestCheckpoint?.folderRun.runId) return [];
      return [projectStatus(entry)];
    });
    // A failed replacement or later run must not erase the last successful
    // checkpoint, including when both runs share the same physical sandbox.
    if (latestCheckpoint && !statuses.some((status) => status.runId === latestCheckpoint.folderRun.runId)) {
      statuses.push(projectStatus(latestCheckpoint));
    }
    res.json(statuses);
  });
  router.post(`${base}/refresh`, async (req, res) => {
    const owner = ownerSchema.parse(req.params);
    const { runId } = z.object({ runId: z.uuid() }).parse(req.body);
    const [row] = await db.select().from(workFolderRuns).where(and(eq(workFolderRuns.runId, runId), eq(workFolderRuns.companyId, owner.companyId)));
    const svc = service();
    const folder = await svc.ensure(owner);
    if (!row || row.manifest.folders[owner.scope] !== folder.id) throw notFound("Run not found");
    const [run] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    if (run?.status !== "running") throw conflict("This run has ended; files will refresh when the next run starts");
    await db.update(workFolderRuns).set({ refreshRequested: true, updatedAt: new Date() }).where(eq(workFolderRuns.runId, runId));
    await audit(req, folder, "refresh", { runId });
    res.status(202).json({ queued: true });
  });
  async function audit(req: Parameters<typeof getActorInfo>[0], folder: { id: string; companyId: string }, action: string, details: Record<string, unknown>) {
    const actor = getActorInfo(req);
    await logActivity(db, { companyId: folder.companyId, actorType: actor.actorType, actorId: actor.actorId,
      agentId: actor.agentId, runId: actor.runId, action: `work_folder.${action}`, entityType: "work_folder", entityId: folder.id, details });
  }
  return router;
}
