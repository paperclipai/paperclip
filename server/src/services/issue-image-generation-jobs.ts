import sharp from "sharp";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assets as assetRows, issueAttachments, issueImageGenerationJobs } from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";
import { issueService, logActivity, resolveAllCredentialEnv } from "./index.js";
import { normalizeContentType } from "../attachment-types.js";
import { logger } from "../middleware/logger.js";
import { notFound, unprocessable } from "../errors.js";
import {
  generateOpenAiIssueImage,
  PAPERCLIP_IMAGE_MODEL,
  streamToBuffer,
  type ImageReferenceInput,
} from "./openai-image-generation.js";
import { generateCodexIssueImage } from "./codex-image-generation.js";

const SUPPORTED_REFERENCE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
]);
const MAX_REFERENCE_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_GENERATED_IMAGE_DIMENSION = 8192;
const GENERATED_IMAGE_ASPECT_RATIO_TOLERANCE = 0.02;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_TICK_INTERVAL_MS = 5_000;

type IssueImageProvider = "codex_native" | "openai";
type ParsedSize = { width: number; height: number };
type JobStatus = "queued" | "running" | "succeeded" | "failed";
type ActorInfo = {
  actorType: "agent" | "user" | "board";
  actorId: string;
  agentId: string | null;
  runId: string | null;
};
type GenerationRequest = {
  prompt: string;
  size: string;
  quality: "auto" | "low" | "medium" | "high";
  model: typeof PAPERCLIP_IMAGE_MODEL;
  outputFilename?: string;
};
type ReferenceSnapshot = {
  boardReferenceIntentDetected: boolean;
  referenceGuardrailApplied: boolean;
  requestedReferenceImageAttachmentIds: string[];
  requestedReferenceImageAssetIds: string[];
  autoBoundReferenceImageAttachmentIds: string[];
  autoBoundReferenceImageAssetIds: string[];
  effectiveReferenceImageAttachmentIds: string[];
  effectiveReferenceImageAssetIds: string[];
  allowedIssueIds: string[];
  exactReferenceRoles: Array<{
    sourceKind: "attachment" | "asset";
    sourceId: string;
    binding: "explicit" | "auto_discovered";
  }>;
};
type EnqueueInput = {
  companyId: string;
  issueId: string;
  idempotencyKey: string;
  actor: ActorInfo;
  request: GenerationRequest;
  referenceSnapshot: ReferenceSnapshot;
  requestFingerprint: string;
};
type JobRow = typeof issueImageGenerationJobs.$inferSelect;
type JobSelect = {
  id: string;
  issueId: string;
  companyId: string;
  idempotencyKey: string;
  status: JobStatus;
  attemptCount: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
  outputAttachmentId: string | null;
  auditAttachmentId: string | null;
  request: GenerationRequest;
  referenceSnapshot: ReferenceSnapshot;
  actor: ActorInfo;
  terminalAudit: Record<string, unknown> | null;
  claimToken: string | null;
};

type PersistedAttachment = {
  id: string;
  companyId: string;
  issueId: string;
  assetId: string;
  objectKey: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  originalFilename: string | null;
};

function resolveIssueImageProvider(): IssueImageProvider {
  const configured = (process.env.PAPERCLIP_IMAGE_PROVIDER ?? process.env.PAPERCLIP_IMAGE_BACKEND ?? "")
    .trim()
    .toLowerCase();
  if (configured === "openai") return "openai";
  if (configured === "codex" || configured === "codex_native" || configured === "codex-native") return "codex_native";
  return "codex_native";
}

export function parseRequestedImageSize(size: string): ParsedSize {
  const match = /^(\d{1,5})x(\d{1,5})$/i.exec(size.trim());
  if (!match) {
    throw unprocessable("Image generation size must be an exact WxH pixel size, for example 1080x1350");
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > MAX_GENERATED_IMAGE_DIMENSION ||
    height > MAX_GENERATED_IMAGE_DIMENSION
  ) {
    throw unprocessable(`Image generation size must be between 1 and ${MAX_GENERATED_IMAGE_DIMENSION} pixels per side`);
  }
  return { width, height };
}

function pngHasExplicitColorSpaceEvidence(bytes: Buffer) {
  return ["sRGB", "iCCP", "gAMA", "cHRM"].some((chunkName) => bytes.includes(Buffer.from(chunkName, "ascii")));
}

async function normalizeGeneratedImageOutput(input: { bytes: Buffer; requestedSize: ParsedSize }) {
  const providerMetadata = await sharp(input.bytes).metadata().catch(() => null);
  if (!providerMetadata?.width || !providerMetadata.height) {
    throw unprocessable("Image generation returned an unreadable image");
  }

  const requestedRatio = input.requestedSize.width / input.requestedSize.height;
  const providerRatio = providerMetadata.width / providerMetadata.height;
  const needsResize =
    providerMetadata.width !== input.requestedSize.width ||
    providerMetadata.height !== input.requestedSize.height;
  if (needsResize && Math.abs(providerRatio - requestedRatio) > GENERATED_IMAGE_ASPECT_RATIO_TOLERANCE) {
    throw unprocessable(
      `Image generation returned ${providerMetadata.width}x${providerMetadata.height}, which cannot be safely normalized to requested ${input.requestedSize.width}x${input.requestedSize.height}`,
    );
  }

  const finalBytes = await sharp(input.bytes)
    .resize({
      width: input.requestedSize.width,
      height: input.requestedSize.height,
      fit: "fill",
    })
    .toColorspace("srgb")
    .withMetadata({ icc: "srgb" })
    .png()
    .toBuffer();
  const finalMetadata = await sharp(finalBytes).metadata();
  if (finalMetadata.width !== input.requestedSize.width || finalMetadata.height !== input.requestedSize.height) {
    throw unprocessable(
      `Image output normalization failed: expected ${input.requestedSize.width}x${input.requestedSize.height}, got ${finalMetadata.width ?? "unknown"}x${finalMetadata.height ?? "unknown"}`,
    );
  }
  if (!pngHasExplicitColorSpaceEvidence(finalBytes)) {
    throw unprocessable("Image output normalization failed to embed explicit sRGB color-space evidence");
  }

  return {
    bytes: finalBytes,
    contentType: "image/png" as const,
    providerDimensions: {
      width: providerMetadata.width,
      height: providerMetadata.height,
    },
    finalDimensions: {
      width: finalMetadata.width,
      height: finalMetadata.height,
    },
    providerColorSpace: providerMetadata.space ?? null,
    finalColorSpace: finalMetadata.space ?? null,
    finalColorProfileBytes: finalMetadata.icc?.length ?? 0,
    finalPngColorSpaceEvidence: {
      sRGB: finalBytes.includes(Buffer.from("sRGB", "ascii")),
      iCCP: finalBytes.includes(Buffer.from("iCCP", "ascii")),
      gAMA: finalBytes.includes(Buffer.from("gAMA", "ascii")),
      cHRM: finalBytes.includes(Buffer.from("cHRM", "ascii")),
    },
    resized: needsResize,
  };
}

function isSupportedReferenceImageContentType(contentType: string) {
  return SUPPORTED_REFERENCE_IMAGE_TYPES.has(normalizeContentType(contentType));
}

function generatedImageFilename(input: string | undefined) {
  return input?.trim() || `paperclip-generated-${Date.now()}.png`;
}

function readJson<T>(value: unknown): T {
  return value as T;
}

function selectShape(job: JobRow): JobSelect {
  return {
    id: job.id,
    issueId: job.issueId,
    companyId: job.companyId,
    idempotencyKey: job.idempotencyKey,
    status: job.status as JobStatus,
    attemptCount: job.attemptCount,
    lastError: job.lastError,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
    outputAttachmentId: job.outputAttachmentId,
    auditAttachmentId: job.auditAttachmentId,
    request: readJson<GenerationRequest>(job.request),
    referenceSnapshot: readJson<ReferenceSnapshot>(job.referenceSnapshot),
    actor: readJson<ActorInfo>(job.actor),
    terminalAudit: readJson<Record<string, unknown> | null>(job.terminalAudit),
    claimToken: job.claimToken,
  };
}

async function loadImageReferences(input: {
  db: Db;
  storage: StorageService;
  issueId: string;
  companyId: string;
  attachmentIds: string[];
  assetIds: string[];
  allowedIssueIds: string[];
}): Promise<ImageReferenceInput[]> {
  const svc = issueService(input.db);
  const references: ImageReferenceInput[] = [];
  const allowedIssueIds = new Set(input.allowedIssueIds.length > 0 ? input.allowedIssueIds : [input.issueId]);

  for (const attachmentId of input.attachmentIds) {
    const attachment = await svc.getAttachmentById(attachmentId);
    if (!attachment) {
      throw notFound(`Reference image attachment not found: ${attachmentId}`);
    }
    if (attachment.companyId !== input.companyId || !allowedIssueIds.has(attachment.issueId)) {
      throw unprocessable(`Reference image attachment does not belong to this issue or its parent chain: ${attachmentId}`);
    }
    if (attachment.byteSize && attachment.byteSize > MAX_REFERENCE_IMAGE_BYTES) {
      throw unprocessable(`Reference image attachment exceeds ${MAX_REFERENCE_IMAGE_BYTES} bytes: ${attachmentId}`);
    }
    const object = await input.storage.getObject(attachment.companyId, attachment.objectKey);
    const contentType = normalizeContentType(attachment.contentType || object.contentType);
    if (!isSupportedReferenceImageContentType(contentType)) {
      throw unprocessable(`Reference attachment must be PNG, JPEG, or WEBP: ${attachmentId}`);
    }
    const bytes = await streamToBuffer(object.stream);
    if (bytes.length <= 0) {
      throw unprocessable(`Reference image attachment is empty: ${attachmentId}`);
    }
    if (bytes.length > MAX_REFERENCE_IMAGE_BYTES) {
      throw unprocessable(`Reference image attachment exceeds ${MAX_REFERENCE_IMAGE_BYTES} bytes: ${attachmentId}`);
    }
    references.push({
      attachmentId,
      sourceKind: "attachment",
      sourceId: attachmentId,
      assetId: attachment.assetId,
      sha256: attachment.sha256,
      filename: attachment.originalFilename,
      contentType,
      bytes,
    });
  }

  for (const assetId of input.assetIds) {
    const asset = await input.db
      .select()
      .from(assetRows)
      .where(and(eq(assetRows.id, assetId), eq(assetRows.companyId, input.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!asset) {
      throw notFound(`Reference image asset not found: ${assetId}`);
    }
    if (!isSupportedReferenceImageContentType(asset.contentType)) {
      throw unprocessable(`Reference asset must be PNG, JPEG, or WEBP: ${assetId}`);
    }
    if (asset.byteSize && asset.byteSize > MAX_REFERENCE_IMAGE_BYTES) {
      throw unprocessable(`Reference image asset exceeds ${MAX_REFERENCE_IMAGE_BYTES} bytes: ${assetId}`);
    }
    const object = await input.storage.getObject(asset.companyId, asset.objectKey);
    const bytes = await streamToBuffer(object.stream);
    if (bytes.length <= 0) {
      throw unprocessable(`Reference image asset is empty: ${assetId}`);
    }
    if (bytes.length > MAX_REFERENCE_IMAGE_BYTES) {
      throw unprocessable(`Reference image asset exceeds ${MAX_REFERENCE_IMAGE_BYTES} bytes: ${assetId}`);
    }
    references.push({
      attachmentId: assetId,
      sourceKind: "asset",
      sourceId: assetId,
      assetId,
      sha256: asset.sha256,
      filename: asset.originalFilename,
      contentType: normalizeContentType(asset.contentType),
      bytes,
    });
  }

  return references;
}

async function createIssueGeneratedAttachment(input: {
  db: Db;
  storage: StorageService;
  issueId: string;
  companyId: string;
  actor: ActorInfo;
  jobId: string;
  claimToken: string;
  leaseMs: number;
  kind: "output" | "audit";
  namespace: string;
  originalFilename: string;
  contentType: string;
  body: Buffer;
}) {
  const stored = await input.storage.putFile({
    companyId: input.companyId,
    namespace: input.namespace,
    originalFilename: input.originalFilename,
    contentType: input.contentType,
    body: input.body,
  });

  try {
    return await input.db.transaction(async (tx) => {
      const claimed = await tx
        .update(issueImageGenerationJobs)
        .set({
          leaseExpiresAt: new Date(Date.now() + input.leaseMs),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(issueImageGenerationJobs.id, input.jobId),
            eq(issueImageGenerationJobs.status, "running"),
            eq(issueImageGenerationJobs.claimToken, input.claimToken),
          ),
        )
        .returning({ id: issueImageGenerationJobs.id });
      if (claimed.length !== 1) {
        throw new Error("Image generation job lease was lost before attachment persistence");
      }

      const [asset] = await tx
        .insert(assetRows)
        .values({
          companyId: input.companyId,
          provider: stored.provider,
          objectKey: stored.objectKey,
          contentType: stored.contentType,
          byteSize: stored.byteSize,
          sha256: stored.sha256,
          originalFilename: stored.originalFilename,
          createdByAgentId: input.actor.agentId,
          createdByUserId: input.actor.actorType === "user" ? input.actor.actorId : null,
        })
        .returning();

      const [attachment] = await tx
        .insert(issueAttachments)
        .values({
          companyId: input.companyId,
          issueId: input.issueId,
          assetId: asset.id,
          issueCommentId: null,
        })
        .returning();

      const linked = await tx
        .update(issueImageGenerationJobs)
        .set(
          input.kind === "output"
            ? { outputAttachmentId: attachment.id, updatedAt: new Date() }
            : { auditAttachmentId: attachment.id, updatedAt: new Date() },
        )
        .where(
          and(
            eq(issueImageGenerationJobs.id, input.jobId),
            eq(issueImageGenerationJobs.status, "running"),
            eq(issueImageGenerationJobs.claimToken, input.claimToken),
          ),
        )
        .returning({ id: issueImageGenerationJobs.id });
      if (linked.length !== 1) {
        throw new Error("Image generation job lease was lost before attachment linkage");
      }

      return {
        id: attachment.id,
        companyId: input.companyId,
        issueId: input.issueId,
        assetId: asset.id,
        objectKey: stored.objectKey,
        contentType: stored.contentType,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        originalFilename: stored.originalFilename,
      } satisfies PersistedAttachment;
    });
  } catch (error) {
    await input.storage.deleteObject(input.companyId, stored.objectKey).catch(() => undefined);
    throw error;
  }
}

export function createIssueImageGenerationJobService(
  db: Db,
  storage: StorageService,
  options: { tickIntervalMs?: number; leaseMs?: number } = {},
) {
  const log = logger.child({ service: "issue-image-generation-jobs" });
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let draining = false;

  async function enqueue(input: EnqueueInput): Promise<JobSelect> {
    const existing = await db
      .select()
      .from(issueImageGenerationJobs)
      .where(
        and(
          eq(issueImageGenerationJobs.issueId, input.issueId),
          eq(issueImageGenerationJobs.idempotencyKey, input.idempotencyKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (existing) {
      if (existing.requestFingerprint !== input.requestFingerprint) {
        throw unprocessable("This idempotency key already belongs to a different image-generation request");
      }
      return selectShape(existing);
    }

    try {
      await db.insert(issueImageGenerationJobs).values({
        companyId: input.companyId,
        issueId: input.issueId,
        idempotencyKey: input.idempotencyKey,
        status: "queued",
        request: input.request,
        referenceSnapshot: input.referenceSnapshot,
        actor: input.actor,
        requestFingerprint: input.requestFingerprint,
      });
    } catch (error) {
      // The pre-read above is only an optimisation. Concurrent requests can
      // still race at the unique index, so resolve that race deterministically.
      const code = (error as { code?: string } | null)?.code;
      if (code !== "23505") throw error;
      const raced = await db.select().from(issueImageGenerationJobs).where(
        and(eq(issueImageGenerationJobs.issueId, input.issueId), eq(issueImageGenerationJobs.idempotencyKey, input.idempotencyKey)),
      ).then((rows) => rows[0] ?? null);
      if (!raced) throw error;
      if (raced.requestFingerprint !== input.requestFingerprint) {
        throw unprocessable("This idempotency key already belongs to a different image-generation request");
      }
      return selectShape(raced);
    }
    const job = await db
      .select()
      .from(issueImageGenerationJobs)
      .where(
        and(
          eq(issueImageGenerationJobs.issueId, input.issueId),
          eq(issueImageGenerationJobs.idempotencyKey, input.idempotencyKey),
        ),
      )
      .then((rows) => rows[0]);
    queueMicrotask(() => {
      void tick();
    });
    return selectShape(job);
  }

  async function getById(input: { issueId: string; jobId: string }): Promise<JobSelect | null> {
    const job = await db
      .select()
      .from(issueImageGenerationJobs)
      .where(and(eq(issueImageGenerationJobs.issueId, input.issueId), eq(issueImageGenerationJobs.id, input.jobId)))
      .then((rows) => rows[0] ?? null);
    return job ? selectShape(job) : null;
  }

  async function claimNext(): Promise<JobSelect | null> {
    const rows = await db.execute(sql`
      WITH candidate AS (
        SELECT id
        FROM issue_image_generation_jobs
        WHERE status = 'queued'
          OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < now())
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE issue_image_generation_jobs AS jobs
      SET
        status = 'running',
        attempt_count = jobs.attempt_count + 1,
        started_at = COALESCE(jobs.started_at, now()),
        claim_token = gen_random_uuid(),
        lease_expires_at = ${new Date(Date.now() + leaseMs)},
        updated_at = now(),
        last_error = NULL
      FROM candidate
      WHERE jobs.id = candidate.id
      RETURNING jobs.*
    `);
    const row = Array.isArray(rows) ? rows[0] : (rows as { rows?: unknown[] }).rows?.[0];
    return row ? selectShape(row as JobRow) : null;
  }

  async function renewLease(job: JobSelect): Promise<boolean> {
    if (!job.claimToken) return false;
    const result = await db.update(issueImageGenerationJobs).set({
      leaseExpiresAt: new Date(Date.now() + leaseMs),
      updatedAt: new Date(),
    }).where(and(
      eq(issueImageGenerationJobs.id, job.id),
      eq(issueImageGenerationJobs.status, "running"),
      eq(issueImageGenerationJobs.claimToken, job.claimToken),
    )).returning({ id: issueImageGenerationJobs.id });
    return result.length === 1;
  }

  async function requireActiveClaim(job: JobSelect) {
    if (!(await renewLease(job))) {
      throw new Error("Image generation job lease was lost to another worker");
    }
  }

  async function clearAttachment(job: JobSelect, kind: "output" | "audit") {
    const attachmentId = kind === "output" ? job.outputAttachmentId : job.auditAttachmentId;
    if (!attachmentId || !job.claimToken) return null;
    try {
      const removed = await db.transaction(async (tx) => {
        const claimed = await tx
          .update(issueImageGenerationJobs)
          .set({
            leaseExpiresAt: new Date(Date.now() + leaseMs),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(issueImageGenerationJobs.id, job.id),
              eq(issueImageGenerationJobs.status, "running"),
              eq(issueImageGenerationJobs.claimToken, job.claimToken),
            ),
          )
          .returning({ id: issueImageGenerationJobs.id });
        if (claimed.length !== 1) {
          throw new Error("Image generation job lease was lost during attachment cleanup");
        }

        const rows = await tx
          .select({
            issueAttachmentId: issueAttachments.id,
            companyId: assetRows.companyId,
            objectKey: assetRows.objectKey,
            assetId: assetRows.id,
          })
          .from(issueAttachments)
          .innerJoin(assetRows, eq(assetRows.id, issueAttachments.assetId))
          .where(eq(issueAttachments.id, attachmentId));
        const attachment = rows[0] ?? null;
        if (!attachment) {
          await tx
            .update(issueImageGenerationJobs)
            .set(
              kind === "output"
                ? { outputAttachmentId: null, updatedAt: new Date() }
                : { auditAttachmentId: null, updatedAt: new Date() },
            )
            .where(eq(issueImageGenerationJobs.id, job.id));
          return null;
        }

        await tx.delete(issueAttachments).where(eq(issueAttachments.id, attachment.issueAttachmentId));
        await tx.delete(assetRows).where(eq(assetRows.id, attachment.assetId));
        await tx
          .update(issueImageGenerationJobs)
          .set(
            kind === "output"
              ? { outputAttachmentId: null, updatedAt: new Date() }
              : { auditAttachmentId: null, updatedAt: new Date() },
          )
          .where(eq(issueImageGenerationJobs.id, job.id));
        return attachment;
      });
      if (removed) await storage.deleteObject(removed.companyId, removed.objectKey);
    } catch (error) {
      log.error({ err: error, attachmentId, jobId: job.id, kind }, "failed to compensate image generation attachment");
    }
    return null;
  }

  async function clearPartialDelivery(job: JobSelect) {
    if (job.auditAttachmentId) await clearAttachment(job, "audit");
    if (job.outputAttachmentId) await clearAttachment(job, "output");
  }

  async function execute(job: JobSelect): Promise<void> {
    if (!job.claimToken) throw new Error("Image generation job has no claim token");
    const requestedSize = parseRequestedImageSize(job.request.size);
    const issue = await issueService(db).getById(job.issueId);
    if (!issue) {
      throw notFound(`Issue not found for image generation job: ${job.issueId}`);
    }
    if (job.outputAttachmentId || job.auditAttachmentId) {
      await clearPartialDelivery(job);
    }

    const references = await loadImageReferences({
      db,
      storage,
      issueId: job.issueId,
      companyId: job.companyId,
      attachmentIds: job.referenceSnapshot.effectiveReferenceImageAttachmentIds,
      assetIds: job.referenceSnapshot.effectiveReferenceImageAssetIds,
      allowedIssueIds: job.referenceSnapshot.allowedIssueIds,
    });
    if (
      (job.referenceSnapshot.effectiveReferenceImageAttachmentIds.length > 0 ||
        job.referenceSnapshot.effectiveReferenceImageAssetIds.length > 0) &&
      references.length === 0
    ) {
      throw unprocessable("No reference image attachment or asset could be bound");
    }
    if (job.referenceSnapshot.referenceGuardrailApplied && references.length === 0) {
      throw unprocessable(
        "The board required an actual image reference, but no usable image attachment or inline asset could be bound. Do not continue with prompt-only generation.",
      );
    }

    const imageProvider = resolveIssueImageProvider();
    const credentialResolution = imageProvider === "openai" && job.actor.agentId
      ? await resolveAllCredentialEnv(db, job.actor.agentId)
      : { env: {} as Record<string, string> };
    // A timer extends the cross-replica lease while the provider is running.
    // Every publication step separately fences on the same claim token.
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      void renewLease(job).then((renewed) => { leaseLost ||= !renewed; }).catch(() => { leaseLost = true; });
    }, Math.max(1_000, Math.floor(leaseMs / 3)));
    heartbeat.unref?.();
    let generated: Awaited<ReturnType<typeof generateOpenAiIssueImage>> | Awaited<ReturnType<typeof generateCodexIssueImage>>;
    try {
      generated = imageProvider === "openai"
        ? await generateOpenAiIssueImage({
          prompt: job.request.prompt,
          size: job.request.size,
          quality: job.request.quality,
          references,
          apiKey: credentialResolution.env.OPENAI_API_KEY,
        })
        : await generateCodexIssueImage({
            prompt: job.request.prompt,
            size: job.request.size,
            quality: job.request.quality,
            references,
            companyId: job.companyId,
            agentId: job.actor.agentId,
            runId: job.actor.runId,
          });
    } finally {
      clearInterval(heartbeat);
    }
    if (leaseLost) throw new Error("Image generation job lease was lost while provider was running");
    await requireActiveClaim(job);
    const normalizedOutput = await normalizeGeneratedImageOutput({
      bytes: generated.outputBytes,
      requestedSize,
    });

    let outputAttachment: PersistedAttachment | null = null;
    let auditAttachment: PersistedAttachment | null = null;
    try {
      outputAttachment = await createIssueGeneratedAttachment({
        db,
        storage,
        issueId: job.issueId,
        companyId: job.companyId,
        actor: job.actor,
        jobId: job.id,
        claimToken: job.claimToken,
        leaseMs,
        kind: "output",
        namespace: `issues/${job.issueId}/generated-images`,
        originalFilename: generatedImageFilename(job.request.outputFilename),
        contentType: normalizedOutput.contentType,
        body: normalizedOutput.bytes,
      });
      if (!outputAttachment) throw new Error("Image output attachment was not created");

    const audit = {
      generatedAt: new Date().toISOString(),
      provider: imageProvider,
      endpoint: generated.endpoint,
      model: generated.model,
      prompt: job.request.prompt,
      size: job.request.size,
      quality: job.request.quality,
      boardReferenceIntentDetected: job.referenceSnapshot.boardReferenceIntentDetected,
      referenceGuardrailApplied: job.referenceSnapshot.referenceGuardrailApplied,
      requestedReferenceImageAttachmentIds: job.referenceSnapshot.requestedReferenceImageAttachmentIds,
      requestedReferenceImageAssetIds: job.referenceSnapshot.requestedReferenceImageAssetIds,
      autoBoundReferenceImageAttachmentIds: job.referenceSnapshot.autoBoundReferenceImageAttachmentIds,
      autoBoundReferenceImageAssetIds: job.referenceSnapshot.autoBoundReferenceImageAssetIds,
      actualImageInputsBound: generated.actualImageInputsBound,
      generationMode: generated.generationMode,
      promptOnly: generated.generationMode === "prompt_only",
      outputAttachmentId: outputAttachment.id,
      outputContentType: normalizedOutput.contentType,
      outputByteSize: normalizedOutput.bytes.length,
      providerOutputDimensions: normalizedOutput.providerDimensions,
      outputDimensions: normalizedOutput.finalDimensions,
      outputNormalized: normalizedOutput.resized,
      providerColorSpace: normalizedOutput.providerColorSpace,
      outputColorSpace: normalizedOutput.finalColorSpace,
      outputColorProfileBytes: normalizedOutput.finalColorProfileBytes,
      outputPngColorSpaceEvidence: normalizedOutput.finalPngColorSpaceEvidence,
      providerRequestId: generated.providerRequestId,
      codexThreadId: "codexThreadId" in generated ? generated.codexThreadId : null,
      codexOutputPath: "codexOutputPath" in generated ? generated.codexOutputPath : null,
      referenceImageInputs: references.map((reference) => ({
        sourceKind: reference.sourceKind ?? "attachment",
        sourceId: reference.sourceId ?? reference.attachmentId,
        attachmentId: reference.sourceKind === "asset" ? null : reference.attachmentId,
        assetId: reference.assetId ?? null,
        sha256: reference.sha256 ?? null,
        filename: reference.filename,
        contentType: reference.contentType,
        byteSize: reference.bytes.length,
      })),
    };

    await requireActiveClaim(job);
    auditAttachment = await createIssueGeneratedAttachment({
      db,
      storage,
      issueId: job.issueId,
      companyId: job.companyId,
      actor: job.actor,
      jobId: job.id,
      claimToken: job.claimToken,
      leaseMs,
      kind: "audit",
      namespace: `issues/${job.issueId}/generated-images/audits`,
      originalFilename: `paperclip-image-audit-${Date.now()}.json`,
      contentType: "application/json",
      body: Buffer.from(JSON.stringify(audit, null, 2), "utf8"),
    });

    const terminal = await db
      .update(issueImageGenerationJobs)
      .set({
        status: "succeeded",
        finishedAt: new Date(),
        updatedAt: new Date(),
        leaseExpiresAt: null,
        claimToken: null,
        outputAttachmentId: outputAttachment.id,
        auditAttachmentId: auditAttachment.id,
        terminalAudit: audit,
      })
      .where(and(
        eq(issueImageGenerationJobs.id, job.id),
        eq(issueImageGenerationJobs.status, "running"),
        eq(issueImageGenerationJobs.claimToken, job.claimToken),
      ))
      .returning({ id: issueImageGenerationJobs.id });
    if (terminal.length !== 1) throw new Error("Image generation job lease was lost before terminal delivery");

    await logActivity(db, {
      companyId: job.companyId,
      actorType: job.actor.actorType === "board" ? "user" : job.actor.actorType,
      actorId: job.actor.actorId,
      agentId: job.actor.agentId,
      runId: job.actor.runId,
      action: "issue.image_generation_created",
      entityType: "issue",
      entityId: job.issueId,
      details: {
        provider: imageProvider,
        model: generated.model,
        generationMode: generated.generationMode,
        boardReferenceIntentDetected: job.referenceSnapshot.boardReferenceIntentDetected,
        referenceGuardrailApplied: job.referenceSnapshot.referenceGuardrailApplied,
        requestedReferenceImageAttachmentIds: job.referenceSnapshot.requestedReferenceImageAttachmentIds,
        requestedReferenceImageAssetIds: job.referenceSnapshot.requestedReferenceImageAssetIds,
        autoBoundReferenceImageAttachmentIds: job.referenceSnapshot.autoBoundReferenceImageAttachmentIds,
        autoBoundReferenceImageAssetIds: job.referenceSnapshot.autoBoundReferenceImageAssetIds,
        actualImageInputsBound: generated.actualImageInputsBound,
        outputAttachmentId: outputAttachment.id,
        auditAttachmentId: auditAttachment.id,
        jobId: job.id,
      },
    }).catch((error) => {
      log.error({ err: error, jobId: job.id }, "failed to write image generation activity");
    });
    } catch (error) {
      await clearPartialDelivery({
        ...job,
        outputAttachmentId: outputAttachment?.id ?? job.outputAttachmentId,
        auditAttachmentId: auditAttachment?.id ?? job.auditAttachmentId,
      });
      throw error;
    }
  }

  async function fail(job: JobSelect, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(issueImageGenerationJobs)
      .set({
        status: "failed",
        lastError: message,
        finishedAt: new Date(),
        updatedAt: new Date(),
        leaseExpiresAt: null,
        claimToken: null,
      })
      .where(and(
        eq(issueImageGenerationJobs.id, job.id),
        eq(issueImageGenerationJobs.status, "running"),
        eq(issueImageGenerationJobs.claimToken, job.claimToken ?? ""),
      ));
  }

  async function tick(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      for (;;) {
        const job = await claimNext();
        if (!job) break;
        try {
          await execute(job);
        } catch (error) {
          log.warn({ err: error, jobId: job.id, issueId: job.issueId }, "issue image generation job failed");
          await fail(job, error);
        }
      }
    } finally {
      draining = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      void tick();
    }, tickIntervalMs);
    timer.unref?.();
    queueMicrotask(() => {
      void tick();
    });
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return {
    enqueue,
    getById,
    tick,
    start,
    stop,
  };
}
