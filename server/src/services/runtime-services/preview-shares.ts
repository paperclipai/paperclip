import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Request } from "express";
import { activityLog, runtimeServiceEvents, runtimeServiceShares, type Db } from "@paperclipai/db";
import type { RuntimeServiceShare } from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../../errors.js";
import { authorizeRuntimeService } from "./authorization.js";
import type { RuntimeServiceManager } from "./manager.js";
import { previewHash, previewSignature } from "./preview-access.js";

export const SHARED_PREVIEW_PATH = "/runtime-previews/shared";
type Share = typeof runtimeServiceShares.$inferSelect;
export function createPreviewShares(db: Db, manager: RuntimeServiceManager, boardBaseURL: () => string) {
  const token = (row: Pick<Share, "id" | "companyId" | "serviceId" | "endpointName">) => previewSignature(`share:${row.id}:${row.companyId}:${row.serviceId}:${row.endpointName}`);
  function view(row: Share): RuntimeServiceShare {
    const url = new URL(`${SHARED_PREVIEW_PATH}/${row.serviceId}/${row.endpointName}/${token(row)}`, boardBaseURL());
    return { id: row.id, endpointName: row.endpointName, expiresAt: row.expiresAt.toISOString(), revokedAt: row.revokedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(), url: row.revokedAt || row.expiresAt.getTime() <= Date.now() ? null : url.toString() };
  }
  async function authorize(req: Request, companyId: string, serviceId: string) {
    const service = await manager.get(companyId, serviceId);
    if (service.desiredState === "deleted") throw notFound("Service not found");
    // Sharing app access is an explicit board operation. Agent tools do not
    // acquire a public-access capability by starting a private dev server.
    if (req.actor.type !== "board") throw forbidden("Only authorized board users can share previews");
    const authorization = await authorizeRuntimeService(db, req, { companyId, serviceId, issueId: service.issueId, mutation: true });
    return { service, actor: authorization.actor };
  }
  return {
    async list(req: Request, companyId: string, serviceId: string) {
      await authorize(req, companyId, serviceId);
      const rows = await db.select().from(runtimeServiceShares).where(and(eq(runtimeServiceShares.companyId, companyId), eq(runtimeServiceShares.serviceId, serviceId)));
      return rows.map(view);
    },
    async create(req: Request, companyId: string, serviceId: string, input: { requestId: string; endpointName: string; expiresAt: string }) {
      const { service, actor } = await authorize(req, companyId, serviceId);
      if (!service.endpoints.some((e) => e.name === input.endpointName && e.url)) throw unprocessable("This endpoint has no preview URL");
      const creationKey = `${actor.id}:${input.requestId}`;
      const expiresAt = new Date(input.expiresAt);
      const find = (database: Pick<Db, "select">) => database.select().from(runtimeServiceShares).where(and(eq(runtimeServiceShares.companyId, companyId), eq(runtimeServiceShares.serviceId, serviceId), eq(runtimeServiceShares.creationKey, creationKey)));
      const check = (row: Share) => {
        if (row.endpointName !== input.endpointName || row.expiresAt.getTime() !== expiresAt.getTime()) throw conflict("This request ID was already used for a different share link");
        return view(row);
      };
      const [prior] = await find(db);
      if (prior) return check(prior);
      if (expiresAt.getTime() <= Date.now() || expiresAt.getTime() > Date.now() + 30 * 24 * 3600_000) throw unprocessable("Choose an expiry within the next 30 days");
      return db.transaction(async (tx) => {
        const id = randomUUID();
        const [inserted] = await tx.insert(runtimeServiceShares).values({ id, companyId, serviceId, endpointName: input.endpointName, creationKey,
          createdByUserId: actor.id, expiresAt, tokenHash: previewHash(token({ id, companyId, serviceId, endpointName: input.endpointName })) }).onConflictDoNothing().returning();
        if (!inserted) { const [existing] = await find(tx); if (!existing) throw conflict("Share creation conflicted; retry the same request"); return check(existing); }
        const details = { shareId: id, endpointName: input.endpointName, expiresAt: expiresAt.toISOString() };
        await tx.insert(runtimeServiceEvents).values({ companyId, serviceId, actor, kind: "share_created", revision: service.revision, details });
        await tx.insert(activityLog).values({ companyId, actorType: "user", actorId: actor.id, action: "runtime_service.share_created", entityType: "runtime_service", entityId: serviceId, details });
        return view(inserted);
      });
    },
    async revoke(req: Request, companyId: string, serviceId: string, shareId: string) {
      const { actor, service } = await authorize(req, companyId, serviceId);
      return db.transaction(async (tx) => {
        const [row] = await tx.select().from(runtimeServiceShares).where(and(eq(runtimeServiceShares.id, shareId), eq(runtimeServiceShares.companyId, companyId), eq(runtimeServiceShares.serviceId, serviceId))).for("update");
        if (!row) throw notFound("Share link not found");
        if (row.revokedAt) return view(row);
        const [next] = await tx.update(runtimeServiceShares).set({ revokedAt: new Date() }).where(eq(runtimeServiceShares.id, row.id)).returning();
        const details = { shareId };
        await tx.insert(runtimeServiceEvents).values({ companyId, serviceId, actor, kind: "share_revoked", revision: service.revision, details });
        await tx.insert(activityLog).values({ companyId, actorType: "user", actorId: actor.id, action: "runtime_service.share_revoked", entityType: "runtime_service", entityId: serviceId, details });
        return view(next!);
      });
    },
  };
}
