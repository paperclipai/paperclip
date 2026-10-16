import { createHash, randomBytes, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import express, { Router } from "express";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { type Db, mcpAttachmentUploads, mcpFileTickets, mcpOauthGrants, issues } from "@paperclipai/db";
import { z } from "zod";
import { MAX_ATTACHMENT_BYTES, isAllowedContentType } from "../../attachment-types.js";
import type { StorageService } from "../../storage/types.js";
import { authorizationService } from "../authorization.js";
import { issueService } from "../issues.js";
import { prepareExternalDeliverablePublication, readExternalDeliverablePublication } from "../native-runtime/external-deliverable-publication.js";
import { logActivity } from "../activity-log.js";
import { hashMcpSecret, McpOAuthError, type PublicMcpOAuth, type McpPrincipal } from "./oauth.js";
import { McpCapabilityError, company, task, requestId, pick, object, stable, type ApiDispatch, type Capability } from "./contracts.js";

const lifetime = 10 * 60_000;
export const uploadSchema = z.object({ ...task, requestId,
  filename: z.string().trim().min(1).max(240).regex(/^[^/\\\x00-\x1f\x7f]+$/),
  contentType: z.string().min(1).max(150).regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/).refine(isAllowedContentType, "Unsupported attachment content type"),
  byteSize: z.number().int().min(1).max(MAX_ATTACHMENT_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).describe("SHA-256 of the exact file bytes. The upload must match this digest and byteSize."),
}).strict();
const attachmentFields = ["id", "issueId", "originalFilename", "contentType", "byteSize", "sha256", "createdAt"];
const unavailable = () => new McpCapabilityError("This transfer is expired, revoked, invalid or no longer authorized. Request a new transfer link from Paperclip.");
function requireWrite(p: McpPrincipal) {
  if (!p.grant.scopes.includes("paperclip:write") || p.actor.memberships?.[0]?.membershipRole === "viewer") throw unavailable();
}

export interface AgentFileSession {
  authorize(p: McpPrincipal, sessionId: string, taskId: string, write: boolean, queryDb?: Db): Promise<{ agentId: string; runId: string }>;
}
export function createPublicMcpTransfers(db: Db, oauth: PublicMcpOAuth, api: ApiDispatch, storage: StorageService,
  options: { pathPrefix?: string; agentSession?: AgentFileSession } = {}) {
  const prefix = options.pathPrefix ?? "/mcp/files";
  async function workSession(p: McpPrincipal, sessionId: string | undefined, taskId: string, write: boolean, queryDb?: Db) {
    if (p.grant.purpose !== "agent") { if (sessionId || options.agentSession) throw unavailable(); return null; }
    if (!sessionId || !options.agentSession) throw unavailable();
    try {
      return await options.agentSession.authorize(p, sessionId, taskId, write, queryDb);
    } catch (error) {
      if (error instanceof McpOAuthError && error.code === "access_denied" && error.status === 409) {
        const workModeDenial = "This task's work mode does not permit deliverable uploads.";
        if (error.message === workModeDenial) throw new McpCapabilityError(workModeDenial);
        throw unavailable();
      }
      throw error;
    }
  }
  const svc = issueService(db);
  async function taskAccess(p: McpPrincipal, taskId: string, write = false, queryDb?: Db, sessionId?: string) {
    await workSession(p, sessionId, taskId, write, queryDb);
    // The public route uses the same domain decision. Inside the upload lock,
    // use its transaction: dispatching through the outer router would borrow a
    // second pool connection and deadlock when all connections hold uploads.
    const database = queryDb ?? (p.grant.purpose === "agent" ? db : undefined);
    const issue = database
      ? (await database.select().from(issues).where(and(eq(issues.id, taskId), eq(issues.companyId, p.grant.companyId))))[0]
      : object(await api(p, "GET", `/issues/${taskId}`));
    if (!issue) throw unavailable();
    if (database) {
      const scope = { issueId: String(issue.id), projectId: issue.projectId as string | null,
        parentIssueId: issue.parentId as string | null, assigneeAgentId: issue.assigneeAgentId as string | null,
        assigneeUserId: issue.assigneeUserId as string | null };
      const decision = await authorizationService(database).decide({ actor: p.actor, action: "issue:read",
        resource: { type: "issue", companyId: p.grant.companyId, ...scope, status: String(issue.status) }, scope });
      if (!decision.allowed) throw unavailable();
    }
    if (issue.companyId !== p.grant.companyId) throw unavailable();
    if (write) {
      if (p.grant.purpose !== "agent") requireWrite(p);
      if (p.grant.purpose !== "agent" && issue.conversationAgentId && issue.conversationUserId !== p.grant.userId) throw unavailable();
    }
    return issue;
  }
  async function attachmentAccess(p: McpPrincipal, id: string, queryDb?: Db, sessionId?: string) {
    const attachment = await (queryDb ? issueService(queryDb) : svc).getAttachmentById(id);
    if (!attachment || attachment.companyId !== p.grant.companyId) throw unavailable();
    await taskAccess(p, attachment.issueId, false, queryDb, sessionId);
    return attachment;
  }
  async function sweep() {
    await db.delete(mcpFileTickets).where(lt(mcpFileTickets.expiresAt, new Date()));
    // Serialize cleanup against completion/reissue. Never remove a committed file.
    await db.transaction(async tx => {
      const abandoned = await tx.select().from(mcpAttachmentUploads).where(and(isNull(mcpAttachmentUploads.attachmentId), isNull(mcpAttachmentUploads.cleanedAt), lt(mcpAttachmentUploads.expiresAt, new Date()))).limit(20).for("update", { skipLocked: true });
      for (const upload of abandoned) {
        if (upload.storageProvider !== storage.provider) continue;
        await storage.deleteObject(upload.companyId, upload.objectKey);
        await tx.update(mcpAttachmentUploads).set({ cleanedAt: new Date() }).where(eq(mcpAttachmentUploads.id, upload.id));
      }
    });
  }
  async function ticket(p: McpPrincipal, target: { uploadId?: string; attachmentId?: string }, sessionId?: string) {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + lifetime);
    await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${p.grant.id}, 0))`);
      const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(mcpFileTickets).where(and(eq(mcpFileTickets.grantId, p.grant.id), gt(mcpFileTickets.expiresAt, new Date())));
      if (count.n >= 100) throw new McpCapabilityError("Too many active file links. Wait for earlier links to expire.");
      await tx.insert(mcpFileTickets).values({ tokenHash: hashMcpSecret(token), companyId: p.grant.companyId, grantId: p.grant.id, workSessionId: sessionId, ...target, expiresAt });
    });
    return { url: `${oauth.config.origin}${prefix}/${target.uploadId ? "upload" : "download"}?ticket=${token}`, expiresAt: expiresAt.toISOString() };
  }
  async function authorize(raw: unknown, upload: boolean) {
    if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(raw)) throw unavailable();
    const [row] = await db.select().from(mcpFileTickets).where(and(eq(mcpFileTickets.tokenHash, hashMcpSecret(raw)), gt(mcpFileTickets.expiresAt, new Date())));
    if (!row || (upload ? !row.uploadId : !row.attachmentId)) throw unavailable();
    const principal = await oauth.authorizeGrant(row.grantId);
    if (row.companyId !== principal.grant.companyId) throw unavailable();
    if (upload && principal.grant.purpose !== "agent") requireWrite(principal);
    if (principal.grant.purpose === "agent") {
      if (!row.workSessionId) throw unavailable();
      const target = upload ? (await db.select().from(mcpAttachmentUploads).where(eq(mcpAttachmentUploads.id, row.uploadId!)))[0]
        : await svc.getAttachmentById(row.attachmentId!);
      const taskId = target && ("taskId" in target ? target.taskId : target.issueId);
      if (!taskId) throw unavailable();
      await workSession(principal, row.workSessionId, taskId, upload);
    } else if (row.workSessionId || options.agentSession) throw unavailable();
    return { row, principal };
  }
  const router = Router();
  router.use(prefix, (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox"); next();
  });
  router.put(prefix + "/upload", async (req, res, next) => {
    await authorize(req.query.ticket, true); next();
  }, express.raw({ type: () => true, limit: MAX_ATTACHMENT_BYTES }), async (req, res) => {
    const { row, principal } = await authorize(req.query.ticket, true);
    const bytes = req.body;
    if (!Buffer.isBuffer(bytes)) throw unavailable();
    const digest = createHash("sha256").update(bytes).digest("hex");
    const published = await db.transaction(async tx => {
      const [upload] = await tx.select().from(mcpAttachmentUploads).where(eq(mcpAttachmentUploads.id, row.uploadId!)).for("update");
      if (!upload || upload.companyId !== principal.grant.companyId || upload.userId !== principal.grant.userId || upload.workSessionId !== row.workSessionId || upload.grantId && upload.grantId !== row.grantId || upload.storageProvider !== storage.provider) throw unavailable();
      if (upload.sha256 !== digest || upload.byteSize !== bytes.length || req.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== upload.contentType) throw new McpCapabilityError("Upload bytes, size or Content-Type do not match the requested file.");
      await taskAccess(principal, upload.taskId, principal.grant.purpose !== "agent", tx as unknown as Db, row.workSessionId ?? undefined);
      const stored = upload.attachmentId ? null : await storage.putFile({ companyId: upload.companyId, namespace: "mcp-transfers", objectKey: upload.objectKey, originalFilename: upload.originalFilename, contentType: upload.contentType, body: bytes });
      await workSession(principal, row.workSessionId ?? undefined, upload.taskId, true, tx as unknown as Db);
      const [grant] = await tx.select().from(mcpOauthGrants).where(eq(mcpOauthGrants.id, row.grantId)).for("update");
      if (!grant || grant.revokedAt || row.expiresAt <= new Date()) throw unavailable();
      const current = await oauth.authorizeGrant(row.grantId, tx as unknown as Db);
      if (current.grant.purpose !== "agent") requireWrite(current);
      await taskAccess(current, upload.taskId, true, tx as unknown as Db, row.workSessionId ?? undefined);
      const session = await workSession(current, row.workSessionId ?? undefined, upload.taskId, true, tx as unknown as Db);
      // Match native mutations: lock the task before the run, then recheck
      // assignment and governance against the locked current task.
      const [issue] = await tx.select().from(issues).where(and(eq(issues.id, upload.taskId), eq(issues.companyId, upload.companyId))).for("update");
      if (!issue || (current.grant.purpose !== "agent" && issue.conversationAgentId && issue.conversationUserId !== current.grant.userId)) throw unavailable();
      await workSession(current, row.workSessionId ?? undefined, upload.taskId, true, tx as unknown as Db);
      const publish = session ? await prepareExternalDeliverablePublication(tx as unknown as Db, {
        companyId: upload.companyId, issueId: upload.taskId, ...session, uploadId: upload.id,
        workSessionId: row.workSessionId!, filename: upload.originalFilename, byteSize: bytes.length, sha256: digest,
      }) : undefined;
      const result = upload.attachmentId
        ? await attachmentAccess(current, upload.attachmentId, tx as unknown as Db, row.workSessionId ?? undefined)
        : await issueService(tx as unknown as Db).createAttachment({ issueId: upload.taskId, ...stored!, createdByUserId: session ? null : current.grant.userId, createdByAgentId: session?.agentId, createdByRunId: session?.runId });
      if (result.originalFilename !== upload.originalFilename || result.byteSize !== bytes.length || result.sha256 !== digest
        || session && (result.originatingRunId !== session.runId || result.createdByAgentId !== session.agentId)) throw unavailable();
      const publication = publish ? await publish(result.id) : undefined;
      if (upload.attachmentId) return { attachment: result, publication };
      await tx.update(mcpAttachmentUploads).set({ attachmentId: result.id }).where(eq(mcpAttachmentUploads.id, upload.id));
      await logActivity(tx as unknown as Db, { companyId: upload.companyId, actorType: session ? "agent" : "user", actorId: session?.agentId ?? current.grant.userId, action: "issue.attachment_added", entityType: "issue", entityId: upload.taskId,
        details: { attachmentId: result.id, originalFilename: result.originalFilename, contentType: result.contentType, byteSize: result.byteSize, mcpConnectionId: row.grantId, ...(session ? { workSessionId: row.workSessionId, authorizingPersonId: current.grant.userId } : {}) } });
      return { attachment: result, publication };
    });
    res.json({ attachment: pick(published.attachment, attachmentFields), ...(published.publication ? { publication: published.publication } : {}) });
  });
  router.get(prefix + "/download", async (req, res) => {
    const { row, principal } = await authorize(req.query.ticket, false);
    const attachment = await attachmentAccess(principal, row.attachmentId!, undefined, row.workSessionId ?? undefined);
    const file = await storage.getObject(attachment.companyId, attachment.objectKey);
    res.attachment(attachment.originalFilename ?? "attachment");
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", attachment.byteSize);
    await pipeline(file.stream, res);
  });
  router.use(prefix, ((err, _req, res, _next) => {
    if (res.headersSent) { res.destroy(); return; }
    const tooLarge = typeof err === "object" && err !== null && "type" in err && err.type === "entity.too.large";
    res.status(tooLarge ? 413 : err instanceof McpCapabilityError ? 403 : 503).json({ error: tooLarge ? "file_too_large" : "transfer_unavailable", message: err instanceof McpCapabilityError ? err.message : "Transfer could not be confirmed. Retry the same upload identity, or request another download link." });
  }) as express.ErrorRequestHandler);
  return {
    router,
    async getUploadUrl(p: McpPrincipal, input: unknown, sessionId?: string) {
      const a = uploadSchema.parse(input);
      await taskAccess(p, a.taskId, true, undefined, sessionId);
      await sweep();
      const hash = hashMcpSecret(stable(sessionId ? { ...a, sessionId, grantId: p.grant.id } : a));
      const id = randomUUID();
      const upload = await db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${p.grant.companyId}:${p.grant.userId}:uploads`}, 0))`);
        const identity = and(eq(mcpAttachmentUploads.companyId, p.grant.companyId), eq(mcpAttachmentUploads.userId, p.grant.userId), eq(mcpAttachmentUploads.requestId, a.requestId));
        let [found] = await tx.select().from(mcpAttachmentUploads).where(identity).for("update");
        if (!found) {
          const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(mcpAttachmentUploads).where(and(eq(mcpAttachmentUploads.companyId, p.grant.companyId), eq(mcpAttachmentUploads.userId, p.grant.userId), isNull(mcpAttachmentUploads.attachmentId), gt(mcpAttachmentUploads.expiresAt, new Date())));
          if (count.n >= 100) throw new McpCapabilityError("Too many pending uploads. Wait for earlier uploads to expire.");
          [found] = await tx.insert(mcpAttachmentUploads).values({ id, companyId: p.grant.companyId, userId: p.grant.userId, grantId: sessionId ? p.grant.id : null, workSessionId: sessionId, requestId: a.requestId, taskId: a.taskId, argumentsHash: hash,
            originalFilename: a.filename, contentType: a.contentType, byteSize: a.byteSize, sha256: a.sha256,
            objectKey: `${p.grant.companyId}/mcp-transfers/${id}`, storageProvider: storage.provider, expiresAt: new Date(Date.now() + lifetime) }).returning();
        }
        if (!found || found.argumentsHash !== hash) throw new McpCapabilityError("requestId was already used for a different upload.");
        await tx.update(mcpAttachmentUploads).set({ expiresAt: new Date(Date.now() + lifetime), cleanedAt: null }).where(eq(mcpAttachmentUploads.id, found.id));
        return found;
      });
      if (upload.attachmentId) {
        const attachment = await attachmentAccess(p, upload.attachmentId, undefined, sessionId);
        const session = await workSession(p, sessionId, upload.taskId, true);
        const publication = session ? await readExternalDeliverablePublication(db, {
          companyId: upload.companyId, issueId: upload.taskId, ...session,
          uploadId: upload.id, workSessionId: sessionId!, attachmentId: attachment.id,
        }) : undefined;
        if (!session || publication) return { attachment: pick(attachment, attachmentFields), status: "completed",
          ...(publication ? { publication } : {}) };
        // An older upload can lack publication proof. Verify the same bytes
        // through another bounded PUT; never manufacture a receipt from metadata.
      }
      return { ...await ticket(p, { uploadId: upload.id }, sessionId), method: "PUT", headers: { "Content-Type": a.contentType }, uploadId: upload.id, maxBytes: MAX_ATTACHMENT_BYTES,
        instructions: "Send the exact file bytes with the given Content-Type. Success saves the attachment and returns its ID. An agent upload also returns a verified publication receipt; cite its evidenceRef in your completion report. There is no separate upload completion tool. Do not share this temporary file credential. Reuse requestId after a lost response." };
    },
    async getDownloadUrl(p: McpPrincipal, attachmentId: string, sessionId?: string) {
      const attachment = await attachmentAccess(p, attachmentId, undefined, sessionId);
      await sweep();
      return { ...await ticket(p, { attachmentId }, sessionId), method: "GET", attachment: pick(attachment, attachmentFields), instructions: "Download this file with your host's HTTP/file tools. This temporary credential permits only this download; do not share it." };
    },
  };
}
export type PublicMcpTransfers = ReturnType<typeof createPublicMcpTransfers>;
export const fileTransferCapabilities: Capability[] = [
  { name: "paperclip_get_upload_url", write: true, ephemeral: true,
    description: "Get a temporary URL to attach a file, video or document to a task. Compute its size and SHA-256 locally, then PUT the exact bytes to the URL. A successful upload saves the attachment immediately and returns its ID. Reuse requestId after a lost response. Requires host file/HTTP tools; if unavailable explain the manual upload step.",
    schema: uploadSchema, run: async (p, a, _api, _origin, transfers) => { if (!transfers) throw unavailable(); return transfers.getUploadUrl(p, a); } },
  { name: "paperclip_get_download_url", ephemeral: true,
    description: "Get a ten-minute download URL for one task attachment from paperclip_list_deliverables. Use your host's HTTP/file tools to download it. This temporary credential does not grant access to other files.",
    schema: z.object({ ...company, attachmentId: z.uuid() }).strict(), run: async (p, a, _api, _origin, transfers) => { if (!transfers) throw unavailable(); return transfers.getDownloadUrl(p, String(a.attachmentId)); } },
];
