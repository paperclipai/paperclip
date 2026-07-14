import { createHmac, randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { deliveryAttestations } from "@paperclipai/db";
import { and, desc, eq } from "drizzle-orm";

export type DeliveryAttestationTargetKind = "repository_checkout" | "remote_operator_checkout" | "artifact_only";

export type DeliveryAttestationDeliveryMethod =
  | "commit"
  | "push"
  | "pull_request"
  | "remote_exec"
  | "provider_sync"
  | "operator_handoff"
  | "controlled_sync"
  | "none";

export type DeliveryAttestationOutcome = "succeeded" | "failed" | "not_attempted" | "operator_confirmation_required";

export interface DeliveryAttestationRow {
  id: string;
  companyId: string;
  issueId: string;
  runId: string;
  declarationId: string;
  declarationRevision: number;
  targetKind: DeliveryAttestationTargetKind;
  targetFingerprint: string;
  providerKey: string;
  outcome: DeliveryAttestationOutcome;
  deliveryMethod: DeliveryAttestationDeliveryMethod;
  sourceRevision: string | null;
  deliveredRevision: string | null;
  destinationRefFingerprint: string | null;
  workspaceDirty: boolean | null;
  operationId: string | null;
  artifactIds: string[];
  generatedAt: Date;
  providerSignature: string;
}

type DeliveryAttestationInsert = Omit<DeliveryAttestationRow, "id" | "providerSignature" | "generatedAt"> & {
  operationId?: string | null;
  artifactIds?: string[];
};

function toRow(row: typeof deliveryAttestations.$inferSelect): DeliveryAttestationRow {
  return {
    id: row.id,
    companyId: row.companyId,
    issueId: row.issueId,
    runId: row.runId,
    declarationId: row.declarationId,
    declarationRevision: row.declarationRevision,
    targetKind: row.targetKind as DeliveryAttestationTargetKind,
    targetFingerprint: row.targetFingerprint,
    providerKey: row.providerKey,
    outcome: row.outcome as DeliveryAttestationOutcome,
    deliveryMethod: row.deliveryMethod as DeliveryAttestationDeliveryMethod,
    sourceRevision: row.sourceRevision ?? null,
    deliveredRevision: row.deliveredRevision ?? null,
    destinationRefFingerprint: row.destinationRefFingerprint ?? null,
    workspaceDirty: row.workspaceDirty ?? null,
    operationId: row.operationId || null,
    artifactIds: (row.artifactIds as string[] | null) ?? [],
    generatedAt: row.generatedAt,
    providerSignature: row.providerSignature,
  };
}

/**
 * providerSignature is server-generated authenticity evidence, not an
 * agent-supplied string (doc/execution-semantics.md, "Durable target and
 * attestation schema"). It is an HMAC over the immutable identity fields of
 * the attestation, domain-separated from other HMAC uses of the same master
 * secret the same way computeTargetFingerprint and the agent JWT signer are.
 */
function computeProviderSignature(input: {
  companyId: string;
  issueId: string;
  runId: string;
  declarationId: string;
  declarationRevision: number;
  targetFingerprint: string;
  outcome: string;
  deliveryMethod: string;
  operationId: string;
  generatedAt: Date;
}): string {
  const masterSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim() || process.env.BETTER_AUTH_SECRET?.trim();
  if (!masterSecret) {
    throw new Error("Cannot sign delivery attestation: no signing secret configured");
  }
  const signingKey = createHmac("sha256", masterSecret).update("delivery-attestation-signature:v1").digest();
  const payload = [
    input.companyId,
    input.issueId,
    input.runId,
    input.declarationId,
    String(input.declarationRevision),
    input.targetFingerprint,
    input.outcome,
    input.deliveryMethod,
    input.operationId,
    input.generatedAt.toISOString(),
  ].join("\n");
  return `v1:${createHmac("sha256", signingKey).update(payload).digest("hex")}`;
}

export function deliveryAttestationService(db: Db) {
  return {
    /**
     * Records provider-generated delivery evidence. Append-only: a repeated
     * call for the exact same (runId, declarationId, declarationRevision,
     * deliveryMethod, operationId) tuple is a no-op — callers reporting a new
     * attempt must mint a new operationId rather than overwrite prior evidence.
     */
    async record(input: DeliveryAttestationInsert): Promise<DeliveryAttestationRow> {
      const id = randomUUID();
      const generatedAt = new Date();
      const operationId = input.operationId ?? "";
      const providerSignature = computeProviderSignature({
        companyId: input.companyId,
        issueId: input.issueId,
        runId: input.runId,
        declarationId: input.declarationId,
        declarationRevision: input.declarationRevision,
        targetFingerprint: input.targetFingerprint,
        outcome: input.outcome,
        deliveryMethod: input.deliveryMethod,
        operationId,
        generatedAt,
      });

      const inserted = await db
        .insert(deliveryAttestations)
        .values({
          id,
          companyId: input.companyId,
          issueId: input.issueId,
          runId: input.runId,
          declarationId: input.declarationId,
          declarationRevision: input.declarationRevision,
          targetKind: input.targetKind,
          targetFingerprint: input.targetFingerprint,
          providerKey: input.providerKey,
          outcome: input.outcome,
          deliveryMethod: input.deliveryMethod,
          sourceRevision: input.sourceRevision ?? null,
          deliveredRevision: input.deliveredRevision ?? null,
          destinationRefFingerprint: input.destinationRefFingerprint ?? null,
          workspaceDirty: input.workspaceDirty ?? null,
          operationId,
          artifactIds: input.artifactIds ?? [],
          generatedAt,
          providerSignature,
        })
        .onConflictDoNothing({
          target: [
            deliveryAttestations.runId,
            deliveryAttestations.declarationId,
            deliveryAttestations.declarationRevision,
            deliveryAttestations.deliveryMethod,
            deliveryAttestations.operationId,
          ],
        })
        .returning()
        .then((rows) => rows[0] ?? null);

      if (inserted) return toRow(inserted);

      // Already recorded under this exact operation key — return the existing row.
      const existing = await db
        .select()
        .from(deliveryAttestations)
        .where(
          and(
            eq(deliveryAttestations.runId, input.runId),
            eq(deliveryAttestations.declarationId, input.declarationId),
            eq(deliveryAttestations.declarationRevision, input.declarationRevision),
            eq(deliveryAttestations.deliveryMethod, input.deliveryMethod),
            eq(deliveryAttestations.operationId, operationId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!existing) throw new Error("Failed to record or locate delivery attestation");
      return toRow(existing);
    },

    async getById(id: string, scope: { companyId: string; issueId: string }): Promise<DeliveryAttestationRow | null> {
      const row = await db
        .select()
        .from(deliveryAttestations)
        .where(
          and(
            eq(deliveryAttestations.id, id),
            eq(deliveryAttestations.companyId, scope.companyId),
            eq(deliveryAttestations.issueId, scope.issueId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      return row ? toRow(row) : null;
    },

    async listForIssue(issueId: string, companyId: string): Promise<DeliveryAttestationRow[]> {
      const rows = await db
        .select()
        .from(deliveryAttestations)
        .where(and(eq(deliveryAttestations.issueId, issueId), eq(deliveryAttestations.companyId, companyId)))
        .orderBy(desc(deliveryAttestations.generatedAt));
      return rows.map(toRow);
    },

    async listForRun(runId: string, companyId: string): Promise<DeliveryAttestationRow[]> {
      const rows = await db
        .select()
        .from(deliveryAttestations)
        .where(and(eq(deliveryAttestations.runId, runId), eq(deliveryAttestations.companyId, companyId)))
        .orderBy(desc(deliveryAttestations.generatedAt));
      return rows.map(toRow);
    },

    /**
     * Finds attestations that could satisfy a workspace_delivery terminal
     * transition for the given issue at its current requirement revision.
     * Scoping strictly by companyId + issueId + declarationRevision + outcome
     * is what prevents an unrelated sibling run (different issueId, or the
     * same issue's stale/prior-revision run) from satisfying this issue's
     * completion — a sibling's rows simply never match this filter.
     */
    async findSucceededForIssue(input: {
      companyId: string;
      issueId: string;
      declarationRevision: number;
    }): Promise<DeliveryAttestationRow[]> {
      const rows = await db
        .select()
        .from(deliveryAttestations)
        .where(
          and(
            eq(deliveryAttestations.companyId, input.companyId),
            eq(deliveryAttestations.issueId, input.issueId),
            eq(deliveryAttestations.declarationRevision, input.declarationRevision),
            eq(deliveryAttestations.outcome, "succeeded"),
          ),
        )
        .orderBy(desc(deliveryAttestations.generatedAt));
      return rows.map(toRow);
    },
  };
}

export type DeliveryAttestationService = ReturnType<typeof deliveryAttestationService>;
