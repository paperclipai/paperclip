import { createHmac, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { assets, heartbeatRuns, issueAttachments, type Db } from "@paperclipai/db";
import { z } from "zod";
import { MAX_ATTACHMENT_BYTES } from "../../attachment-types.js";
import type { StorageService } from "../../storage/types.js";
import { authorizeHistoricalRunnerAttachment } from "./chat-attachment-read.js";
import type { ChatReuseBinding } from "./chat-attachment-reuse.js";
import {
  readBoundedStorageObject,
  resolveNativeRunnerWakeAttachmentSelections,
  type NativeRunnerAttachmentSource,
} from "./native-runner-file-handoff.js";

export const RUNNER_ATTACHMENT_DOWNLOAD_PATH = "/api/runtime/runner/attachment";
const maxBytes = Math.min(MAX_ATTACHMENT_BYTES, 10 * 1024 * 1024);
const ttlMs = 30_000;
const claimsSchema = z.object({
  companyId: z.uuid(), issueId: z.uuid(), runId: z.uuid(), agentId: z.uuid(),
  attachmentId: z.uuid(), sourceCommentId: z.uuid(),
  kind: z.enum(["wake", "history"]),
  turnId: z.string().min(1).max(160),
  contentType: z.string().min(1).max(128),
  byteSize: z.number().int().min(0).max(maxBytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number().int(),
}).strict();

function signingSecret(env: NodeJS.ProcessEnv) {
  return env.PAPERCLIP_AGENT_JWT_SECRET?.trim() || env.BETTER_AUTH_SECRET?.trim();
}

function sign(secret: string, body: Buffer) {
  return createHmac("sha256", secret).update("paperclip.runner.attachment.v1\0").update(body).digest();
}

export function runnerAttachmentDownloadUrl(env: NodeJS.ProcessEnv = process.env) {
  if (!signingSecret(env)) return null;
  const configured = env.PAPERCLIP_PUBLIC_URL || env.PAPERCLIP_AUTH_PUBLIC_BASE_URL || env.PAPERCLIP_MANAGED_RUNTIME_PUBLIC_URL;
  if (!configured) return null;
  try {
    const origin = new URL(configured);
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) return null;
    return new URL(RUNNER_ATTACHMENT_DOWNLOAD_PATH, origin).href;
  } catch {
    return null;
  }
}

export function createRunnerAttachmentGrant(
  binding: ChatReuseBinding,
  source: NativeRunnerAttachmentSource,
  turnId: string,
  url: string,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
) {
  const secret = signingSecret(env);
  const claims = claimsSchema.parse({
    companyId: binding.companyId, issueId: binding.issueId, runId: binding.runId, agentId: binding.agentId,
    ...source, turnId, sha256: source.sha256.toLowerCase(), expiresAt: now + ttlMs,
  });
  if (!secret) throw new Error("runner_attachment_download_secret_unavailable");
  const body = Buffer.from(JSON.stringify(claims));
  const token = Buffer.concat([sign(secret, body), body]).toString("base64url");
  if (token.length > 1024) throw new Error("runner_attachment_download_grant_too_large");
  return { url, token, byteSize: claims.byteSize, sha256: claims.sha256, contentType: claims.contentType };
}

export function verifyRunnerAttachmentGrant(token: string, env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  const secret = signingSecret(env);
  if (!secret || !/^[A-Za-z0-9_-]{44,1024}$/.test(token)) return null;
  const bytes = Buffer.from(token, "base64url");
  if (bytes.length <= 32 || bytes.toString("base64url") !== token) return null;
  const body = bytes.subarray(32);
  if (!timingSafeEqual(bytes.subarray(0, 32), sign(secret, body))) return null;
  try {
    const parsed = claimsSchema.safeParse(JSON.parse(body.toString("utf8")));
    return parsed.success && parsed.data.expiresAt > now ? parsed.data : null;
  } catch {
    return null;
  }
}

async function authorizedSource(db: Db, claims: z.infer<typeof claimsSchema>) {
  if (claims.kind === "history") {
    const [run] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, claims.companyId), eq(heartbeatRuns.id, claims.runId),
      eq(heartbeatRuns.nativeIssueId, claims.issueId), eq(heartbeatRuns.agentId, claims.agentId),
      eq(heartbeatRuns.runtimeMode, "native"), eq(heartbeatRuns.status, "running"),
    )).limit(1);
    if (!run) return null;
    return authorizeHistoricalRunnerAttachment(db, claims, {
      attachmentId: claims.attachmentId, sourceCommentId: claims.sourceCommentId,
    });
  }
  const wake = await resolveNativeRunnerWakeAttachmentSelections({ db, binding: claims, requireRunning: true });
  if (!wake.some(({ id, commentId }) => id === claims.attachmentId && commentId === claims.sourceCommentId)) return null;
  const [attachment] = await db.select({
    objectKey: assets.objectKey, contentType: assets.contentType, byteSize: assets.byteSize, sha256: assets.sha256,
  }).from(issueAttachments).innerJoin(assets, and(
    eq(assets.id, issueAttachments.assetId), eq(assets.companyId, claims.companyId),
  )).where(and(
    eq(issueAttachments.companyId, claims.companyId), eq(issueAttachments.issueId, claims.issueId),
    eq(issueAttachments.id, claims.attachmentId), eq(issueAttachments.issueCommentId, claims.sourceCommentId),
  )).limit(1);
  return attachment ?? null;
}

export function runnerAttachmentDownloadRoutes(db: Db, storage: StorageService, env: NodeJS.ProcessEnv = process.env) {
  const router = Router();
  router.get(RUNNER_ATTACHMENT_DOWNLOAD_PATH, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const match = /^Bearer ([A-Za-z0-9_-]{44,1024})$/.exec(req.get("Authorization") ?? "");
    const claims = match && verifyRunnerAttachmentGrant(match[1]!, env);
    if (!claims) { res.status(404).end(); return; }
    try {
      const source = await authorizedSource(db, claims);
      if (!source || source.contentType !== claims.contentType || source.byteSize !== claims.byteSize
        || source.sha256.toLowerCase() !== claims.sha256) {
        res.status(404).end();
        return;
      }
      const body = await readBoundedStorageObject({
        storage, companyId: claims.companyId, objectKey: source.objectKey,
        expectedByteSize: claims.byteSize, expectedSha256: claims.sha256,
        allowEmpty: claims.kind === "history", signal: AbortSignal.timeout(8_000),
      });
      const current = await authorizedSource(db, claims);
      if (!current || current.objectKey !== source.objectKey || current.byteSize !== claims.byteSize
        || current.contentType !== claims.contentType || current.sha256.toLowerCase() !== claims.sha256
        || Date.now() >= claims.expiresAt) {
        res.status(404).end();
        return;
      }
      res.set("Content-Type", "application/octet-stream");
      res.set("Content-Length", String(body.length));
      res.set("X-Content-Type-Options", "nosniff");
      res.end(body);
    } catch {
      res.status(404).end();
    }
  });
  return router;
}
