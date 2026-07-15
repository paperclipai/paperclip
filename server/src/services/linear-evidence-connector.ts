import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import {
  linearEvidenceConflicts,
  linearEvidenceDeliveries,
  linearEvidenceMappings,
  type Db,
} from "@paperclipai/db";
import {
  buildLinearEvidenceComment,
  linearEvidenceCommentSha256,
  linearEvidenceIdempotencyKey,
  linearEvidenceMappingKey,
  linearEvidencePayloadSha256,
  type LinearEvidenceBridgeReader,
  type LinearEvidenceCompletionSnapshot,
  type LinearEvidencePayload,
} from "./linear-evidence-bridge.js";

export interface LinearCommentReceipt {
  id: string;
  linearIssueId: string;
  body: string;
  createdAt: string;
}

/** The credential-bearing Linear client lives outside Paperclip core. */
export interface LinearEvidenceTransport {
  findCommentByMarker(input: { linearIssueId: string; marker: string }): Promise<LinearCommentReceipt | null>;
  createComment(input: { linearIssueId: string; body: string }): Promise<{ id: string }>;
  getComment(input: { linearIssueId: string; commentId: string }): Promise<LinearCommentReceipt | null>;
}

export class LinearEvidenceConnectorError extends Error {
  constructor(public readonly code: "invalid_evidence" | "mapping_conflict" | "remote_conflict" | "delivery_ambiguous") {
    super(`Linear evidence connector failed: ${code}`);
    this.name = "LinearEvidenceConnectorError";
  }
}

export interface LinearEvidencePublishInput {
  companyId: string;
  paperclipIssueId: string;
  linearIssueId: string;
  evidence: LinearEvidencePayload;
  dryRun?: boolean;
}

function validIso(value: string) {
  return !Number.isNaN(Date.parse(value));
}

function validateInput(input: LinearEvidencePublishInput) {
  const expectedMappingKey = linearEvidenceMappingKey(input.companyId, input.paperclipIssueId);
  const evidence = input.evidence;
  const artifactOk = Boolean(
    (evidence.artifact.sha256 && /^[a-f0-9]{64}$/i.test(evidence.artifact.sha256)) ||
    (evidence.artifact.pullRequestUrl && /^https:\/\/[^\s]+\/(?:pull|merge_requests)\/\d+(?:\/|$)/.test(evidence.artifact.pullRequestUrl)),
  );
  if (
    evidence.mappingKey !== expectedMappingKey ||
    evidence.paperclipIssueId !== input.paperclipIssueId ||
    evidence.linearIssueId !== input.linearIssueId ||
    !validIso(evidence.paperclipIssueUpdatedAt) ||
    !validIso(evidence.recordedAt) ||
    !validIso(evidence.verification.testedAt) ||
    !evidence.implementerId.trim() ||
    !evidence.whatChanged.trim() ||
    !evidence.verification.verifierId.trim() ||
    !evidence.verification.summary.trim() ||
    evidence.verification.result !== "passed" ||
    !evidence.verification.independent ||
    evidence.verification.verifierId === evidence.implementerId ||
    !artifactOk
  ) throw new LinearEvidenceConnectorError("invalid_evidence");
}

export function linearEvidenceConnector(
  db: Db,
  transport: LinearEvidenceTransport,
  options: { now?: () => Date; leaseMs?: number } = {},
): LinearEvidenceBridgeReader & { publish(input: LinearEvidencePublishInput): Promise<LinearEvidenceCompletionSnapshot> } {
  const now = options.now ?? (() => new Date());
  const leaseMs = options.leaseMs ?? 30_000;

  async function recordConflict(mappingId: string, key: string, paperclipValue: unknown, linearValue: unknown) {
    const fingerprint = linearEvidencePayloadSha256({
      contractVersion: 1,
      mappingKey: key,
      paperclipIssueId: mappingId,
      paperclipIssueUpdatedAt: "1970-01-01T00:00:00.000Z",
      linearIssueId: String(linearValue),
      implementerId: "connector",
      whatChanged: JSON.stringify(paperclipValue),
      artifact: { sha256: "0".repeat(64) },
      verification: { verifierId: "connector", independent: true, result: "passed", summary: key, testedAt: "1970-01-01T00:00:00.000Z" },
      recordedAt: "1970-01-01T00:00:00.000Z",
    });
    await db.insert(linearEvidenceConflicts).values({
      mappingId,
      conflictKey: key,
      fingerprint,
      paperclipValue: paperclipValue as never,
      linearValue: linearValue as never,
    }).onConflictDoNothing();
  }

  async function ensureMapping(input: LinearEvidencePublishInput) {
    const mappingKey = linearEvidenceMappingKey(input.companyId, input.paperclipIssueId);
    await db.insert(linearEvidenceMappings).values({
      companyId: input.companyId,
      paperclipIssueId: input.paperclipIssueId,
      mappingKey,
      linearIssueId: input.linearIssueId,
    }).onConflictDoNothing();
    const [mapping] = await db.select().from(linearEvidenceMappings)
      .where(eq(linearEvidenceMappings.paperclipIssueId, input.paperclipIssueId)).limit(1);
    if (!mapping) throw new LinearEvidenceConnectorError("mapping_conflict");
    if (mapping.companyId !== input.companyId || mapping.mappingKey !== mappingKey || mapping.linearIssueId !== input.linearIssueId) {
      await recordConflict(mapping.id, "linear_issue_mapping", input.linearIssueId, mapping.linearIssueId);
      throw new LinearEvidenceConnectorError("mapping_conflict");
    }
    return mapping;
  }

  async function getCompletionSnapshot(input: Parameters<LinearEvidenceBridgeReader["getCompletionSnapshot"]>[0]) {
    const [mapping] = await db.select().from(linearEvidenceMappings)
      .where(and(eq(linearEvidenceMappings.companyId, input.companyId), eq(linearEvidenceMappings.paperclipIssueId, input.paperclipIssueId)))
      .limit(1);
    if (!mapping) return null;
    const version = input.paperclipIssueUpdatedAt ? new Date(input.paperclipIssueUpdatedAt) : null;
    if (!version || Number.isNaN(version.getTime())) return null;
    const [delivery] = await db.select().from(linearEvidenceDeliveries)
      .where(and(eq(linearEvidenceDeliveries.mappingId, mapping.id), eq(linearEvidenceDeliveries.paperclipIssueUpdatedAt, version)))
      .orderBy(desc(linearEvidenceDeliveries.createdAt)).limit(1);
    if (!delivery) return null;
    const conflicts = await db.select().from(linearEvidenceConflicts).where(eq(linearEvidenceConflicts.mappingId, mapping.id));
    return {
      mappingKey: mapping.mappingKey,
      linearIssueId: mapping.linearIssueId,
      evidence: delivery.evidenceJson as unknown as LinearEvidencePayload,
      evidenceSha256: delivery.evidenceSha256,
      idempotencyKey: delivery.idempotencyKey,
      delivery: {
        state: delivery.state,
        idempotencyKey: delivery.idempotencyKey,
        commentBodySha256: delivery.commentBodySha256,
        remoteCommentId: delivery.remoteCommentId,
        publishedAt: delivery.publishedAt?.toISOString() ?? null,
      },
      conflicts: conflicts.map((row) => ({
        key: row.conflictKey,
        paperclipValue: row.paperclipValue,
        linearValue: row.linearValue,
        detectedAt: row.detectedAt.toISOString(),
        resolution: row.resolution,
      })),
    } satisfies LinearEvidenceCompletionSnapshot;
  }

  async function publish(input: LinearEvidencePublishInput) {
    validateInput(input);
    const mapping = await ensureMapping(input);
    const evidenceSha256 = linearEvidencePayloadSha256(input.evidence);
    const idempotencyKey = linearEvidenceIdempotencyKey(input.evidence);
    const body = buildLinearEvidenceComment(input.evidence);
    const bodySha = linearEvidenceCommentSha256(input.evidence);
    await db.insert(linearEvidenceDeliveries).values({
      mappingId: mapping.id,
      paperclipIssueUpdatedAt: new Date(input.evidence.paperclipIssueUpdatedAt),
      evidenceSha256,
      idempotencyKey,
      evidenceJson: input.evidence as unknown as Record<string, unknown>,
      commentBodySha256: bodySha,
    }).onConflictDoNothing();
    let [delivery] = await db.select().from(linearEvidenceDeliveries).where(eq(linearEvidenceDeliveries.idempotencyKey, idempotencyKey)).limit(1);
    if (!delivery) throw new LinearEvidenceConnectorError("delivery_ambiguous");
    if (delivery.evidenceSha256 !== evidenceSha256 || delivery.commentBodySha256 !== bodySha) {
      await recordConflict(mapping.id, "idempotency_collision", evidenceSha256, delivery.evidenceSha256);
      throw new LinearEvidenceConnectorError("remote_conflict");
    }
    if (delivery.state !== "published" && !input.dryRun) {
      const leaseToken = randomUUID();
      const [claimed] = await db.update(linearEvidenceDeliveries).set({
        leaseToken,
        leaseExpiresAt: new Date(now().getTime() + leaseMs),
        updatedAt: now(),
      }).where(and(
        eq(linearEvidenceDeliveries.id, delivery.id),
        eq(linearEvidenceDeliveries.state, "pending"),
        or(isNull(linearEvidenceDeliveries.leaseExpiresAt), lt(linearEvidenceDeliveries.leaseExpiresAt, now())),
      )).returning();
      if (claimed) {
        const marker = `<!-- paperclip-evidence:${idempotencyKey} -->`;
        try {
          let remote = await transport.findCommentByMarker({ linearIssueId: input.linearIssueId, marker });
          if (!remote) {
            const created = await transport.createComment({ linearIssueId: input.linearIssueId, body });
            remote = await transport.getComment({ linearIssueId: input.linearIssueId, commentId: created.id });
          }
          if (!remote) throw new LinearEvidenceConnectorError("delivery_ambiguous");
          if (remote.linearIssueId !== input.linearIssueId || remote.body !== body || !validIso(remote.createdAt)) {
            await recordConflict(mapping.id, "remote_comment", bodySha, remote.body);
            await db.update(linearEvidenceDeliveries).set({ state: "conflict", leaseToken: null, leaseExpiresAt: null, lastErrorCode: "remote_conflict", updatedAt: now() })
              .where(eq(linearEvidenceDeliveries.id, delivery.id));
            throw new LinearEvidenceConnectorError("remote_conflict");
          }
          await db.update(linearEvidenceDeliveries).set({
            state: "published",
            remoteCommentId: remote.id,
            publishedAt: new Date(remote.createdAt),
            leaseToken: null,
            leaseExpiresAt: null,
            lastErrorCode: null,
            updatedAt: now(),
          }).where(and(eq(linearEvidenceDeliveries.id, delivery.id), eq(linearEvidenceDeliveries.leaseToken, leaseToken)));
        } catch (error) {
          if (!(error instanceof LinearEvidenceConnectorError && error.code === "remote_conflict")) {
            await db.update(linearEvidenceDeliveries).set({ leaseToken: null, leaseExpiresAt: null, lastErrorCode: "delivery_ambiguous", updatedAt: now() })
              .where(and(eq(linearEvidenceDeliveries.id, delivery.id), eq(linearEvidenceDeliveries.leaseToken, leaseToken)));
          }
          throw error instanceof LinearEvidenceConnectorError ? error : new LinearEvidenceConnectorError("delivery_ambiguous");
        }
      }
      [delivery] = await db.select().from(linearEvidenceDeliveries).where(eq(linearEvidenceDeliveries.id, delivery.id)).limit(1);
    }
    const snapshot = await getCompletionSnapshot({
      companyId: input.companyId,
      paperclipIssueId: input.paperclipIssueId,
      paperclipIssueUpdatedAt: input.evidence.paperclipIssueUpdatedAt,
      mappingKey: input.evidence.mappingKey,
    });
    if (!snapshot) throw new LinearEvidenceConnectorError("delivery_ambiguous");
    return snapshot;
  }

  return { publish, getCompletionSnapshot };
}
