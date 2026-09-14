import { createHash, createHmac, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import type { Request } from "express";
import { authUsers, companyMemberships, instanceUserRoles, runtimeServicePreviewSessions, runtimeServiceShares, type Db } from "@paperclipai/db";
import { forbidden, notFound, unauthorized } from "../../errors.js";
import { authorizeRuntimeService } from "./authorization.js";
import { resolveRuntimeServiceToolActor } from "./tool-actor.js";
import type { RuntimeServiceManager } from "./manager.js";
import { previewInstanceIdentity } from "./preview-config.js";

export const PREVIEW_COOKIE = "__Host-Http-paperclip-preview";
export const previewHash = (value: string) => createHash("sha256").update(value).digest("hex");
export function previewSignature(value: string): string {
  const key = process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim() || process.env.BETTER_AUTH_SECRET?.trim();
  if (!key) throw new Error("Preview signing key is unavailable");
  return createHmac("sha256", key).update(`runtime-preview:${previewInstanceIdentity()}:${value}`).digest("base64url");
}
type Scope = { companyId: string; serviceId: string; endpointName: string };
type Session = typeof runtimeServicePreviewSessions.$inferSelect;

export function createPreviewAccess(db: Db, manager: RuntimeServiceManager, options: { allowLocalBoard: boolean }) {
  async function authorize(session: Session) {
    if (session.expiresAt.getTime() <= Date.now()) throw unauthorized("Preview access expired");
    const service = await manager.get(session.companyId, session.serviceId);
    if (service.desiredState === "deleted") throw notFound("Preview not found");
    if (session.subjectType === "share") {
      const [share] = await db.select().from(runtimeServiceShares).where(and(
        eq(runtimeServiceShares.id, session.shareId!), eq(runtimeServiceShares.companyId, session.companyId),
        eq(runtimeServiceShares.serviceId, session.serviceId), eq(runtimeServiceShares.endpointName, session.endpointName),
        isNull(runtimeServiceShares.revokedAt), gt(runtimeServiceShares.expiresAt, new Date()),
      ));
      if (!share) throw unauthorized("Shared preview access expired or was revoked");
      return;
    }
    let req: Request;
    if (session.subjectType === "local_board" && options.allowLocalBoard) {
      req = { method: "GET", actor: { type: "board", source: "local_implicit", userId: session.subjectId, isInstanceAdmin: true } } as Request;
    } else if (session.subjectType === "agent" && session.runId) {
      req = (await resolveRuntimeServiceToolActor(db, { companyId: session.companyId, agentId: session.subjectId, runId: session.runId }, "services_inspect")).req;
    } else if (session.subjectType === "user") {
      const [user] = await db.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.id, session.subjectId));
      if (!user) throw unauthorized("Preview access is no longer available");
      const [memberships, roles] = await Promise.all([
        db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, session.companyId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, session.subjectId), eq(companyMemberships.status, "active"))),
        db.select().from(instanceUserRoles).where(and(eq(instanceUserRoles.userId, session.subjectId), eq(instanceUserRoles.role, "instance_admin"))),
      ]);
      const actor: Request["actor"] = { type: "board", source: "session", userId: session.subjectId, isInstanceAdmin: roles.length > 0, companyIds: memberships.map((m) => m.companyId), memberships };
      req = { method: "GET", actor } as Request;
    } else throw unauthorized("Preview access is no longer available");
    await authorizeRuntimeService(db, req, { companyId: session.companyId, serviceId: session.serviceId, issueId: service.issueId });
  }
  async function mint(scope: Scope, subject: Pick<Session, "subjectType" | "subjectId" | "runId" | "shareId">, expiresAt: Date) {
    const ticket = randomBytes(32).toString("base64url");
    await db.insert(runtimeServicePreviewSessions).values({ ...scope, ...subject, ticketHash: previewHash(ticket), ticketExpiresAt: new Date(Date.now() + 60_000), expiresAt });
    return ticket;
  }
  return {
    async grant(req: Request, scope: Scope) {
      const service = await manager.get(scope.companyId, scope.serviceId);
      await authorizeRuntimeService(db, req, { ...scope, issueId: service.issueId });
      const actor = req.actor;
      if (actor.type === "agent" && !actor.runId) throw forbidden("Preview credentials require an active run");
      if (actor.type === "none") throw unauthorized();
      const local = actor.type === "board" && actor.source === "local_implicit";
      if (local && !options.allowLocalBoard) throw forbidden("A signed-in user is required for preview access");
      return mint(scope, {
        subjectType: actor.type === "agent" ? "agent" : local ? "local_board" : "user",
        subjectId: actor.agentId ?? actor.userId ?? "local-board", runId: actor.runId ?? null, shareId: null,
      }, new Date(Date.now() + 12 * 60 * 60_000));
    },
    async grantShare(scope: Scope, token: string) {
      const [share] = await db.select().from(runtimeServiceShares).where(and(
        eq(runtimeServiceShares.companyId, scope.companyId), eq(runtimeServiceShares.serviceId, scope.serviceId),
        eq(runtimeServiceShares.endpointName, scope.endpointName), eq(runtimeServiceShares.tokenHash, previewHash(token)),
        isNull(runtimeServiceShares.revokedAt), gt(runtimeServiceShares.expiresAt, new Date()),
      ));
      if (!share) throw unauthorized("Share link expired or was revoked");
      return mint(scope, { subjectType: "share", subjectId: share.id, shareId: share.id, runId: null }, share.expiresAt);
    },
    async consume(scope: Scope, ticket: string) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw unauthorized("Invalid preview handoff");
      const [candidate] = await db.select().from(runtimeServicePreviewSessions).where(and(
        eq(runtimeServicePreviewSessions.ticketHash, previewHash(ticket)), eq(runtimeServicePreviewSessions.companyId, scope.companyId),
        eq(runtimeServicePreviewSessions.serviceId, scope.serviceId), eq(runtimeServicePreviewSessions.endpointName, scope.endpointName),
        isNull(runtimeServicePreviewSessions.consumedAt), gt(runtimeServicePreviewSessions.ticketExpiresAt, new Date()),
      ));
      if (!candidate) throw unauthorized("Preview handoff expired or was already used");
      await authorize(candidate);
      const token = randomBytes(32).toString("base64url");
      const [consumed] = await db.update(runtimeServicePreviewSessions).set({ consumedAt: new Date(), sessionHash: previewHash(token) })
        .where(and(eq(runtimeServicePreviewSessions.id, candidate.id), isNull(runtimeServicePreviewSessions.consumedAt), gt(runtimeServicePreviewSessions.ticketExpiresAt, new Date()))).returning();
      if (!consumed) throw unauthorized("Preview handoff was already used");
      return { token, expiresAt: consumed.expiresAt };
    },
    async authenticate(scope: Scope, cookie: string | undefined) {
      const values = (cookie ?? "").split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${PREVIEW_COOKIE}=`));
      if (values.length !== 1) throw unauthorized("Sign in to open this preview");
      const value = values[0]!.slice(PREVIEW_COOKIE.length + 1);
      if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw unauthorized("Sign in to open this preview");
      const [session] = await db.select().from(runtimeServicePreviewSessions).where(and(
        eq(runtimeServicePreviewSessions.sessionHash, previewHash(value)), eq(runtimeServicePreviewSessions.companyId, scope.companyId),
        eq(runtimeServicePreviewSessions.serviceId, scope.serviceId), eq(runtimeServicePreviewSessions.endpointName, scope.endpointName),
        gt(runtimeServicePreviewSessions.expiresAt, new Date()),
      ));
      if (!session) throw unauthorized("Sign in to open this preview");
      await authorize(session);
      return session;
    },
    async prune() { await db.delete(runtimeServicePreviewSessions).where(lt(runtimeServicePreviewSessions.expiresAt, new Date())); },
  };
}
