import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  issueComments,
  issueThreadInteractions,
  releaseCandidateAuditEvents,
  releaseCandidates,
  releaseDeployAuthorizations,
} from "@paperclipai/db";
import type { IssueCommentMetadata, IssueThreadInteraction } from "@paperclipai/shared";
import { conflict, notFound, unauthorized, unprocessable } from "../errors.js";

export const RELEASE_CANDIDATE_CONFIRMATION_TARGET_PREFIX = "release_candidate:";
const DEPLOY_AUTH_TOKEN_BYTES = 32;
const DEFAULT_AUTH_TTL_MS = 15 * 60 * 1000;

type Actor = {
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
};

type CandidateRow = typeof releaseCandidates.$inferSelect;
type AuthorizationRow = typeof releaseDeployAuthorizations.$inferSelect;

export type CreateReleaseCandidateInput = Pick<
  typeof releaseCandidates.$inferInsert,
  | "companyId"
  | "sourceIssueId"
  | "commitSha"
  | "imageDigest"
  | "signatureBundleRef"
  | "signatureBundleSha256"
  | "provenanceRef"
  | "sbomHash"
  | "workflowRunUrl"
  | "environment"
  | "targetHost"
  | "sequence"
> & {
  documentRevisionId?: string | null;
  metadata?: Record<string, unknown>;
};

export type UpdateReleaseCandidateInput = Partial<Pick<
  typeof releaseCandidates.$inferInsert,
  "signatureBundleRef" | "signatureBundleSha256" | "provenanceRef" | "workflowRunUrl" | "documentRevisionId" | "metadata"
>>;

export type RelayArtifactInput = {
  imageDigest: string;
  sbomHash: string;
  signatureVerified: boolean;
  sbomVerified: boolean;
  tarballSha256: string;
  signatureBundleSha256: string;
  tarballBytes: Buffer;
  signatureBundleBytes: Buffer;
  originalFilename?: string | null;
  signatureBundleFilename?: string | null;
};

export type RelayArtifactVerificationInput = Omit<
  RelayArtifactInput,
  "tarballBytes" | "signatureBundleBytes" | "originalFilename" | "signatureBundleFilename"
>;

export type DeployRecordInput = {
  authorizationId: string;
  token: string;
  status: "started" | "succeeded" | "failed" | "rolled_back";
  message?: string | null;
  commitSha?: string | null;
  healthStatus?: string | null;
  rollbackReason?: string | null;
  metadata?: Record<string, unknown>;
};

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeSha256(value: string) {
  return value.replace(/^sha256:/i, "").toLowerCase();
}

function generateDeployToken() {
  const secret = `pcdeploy_${randomBytes(DEPLOY_AUTH_TOKEN_BYTES).toString("base64url")}`;
  return {
    secret,
    hash: sha256(secret),
    prefix: secret.slice(0, 18),
  };
}

function tokenHashMatches(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function assertCandidateMutable(candidate: CandidateRow) {
  if (candidate.approvalInteractionId || candidate.status !== "candidate_created") {
    throw conflict("Release candidate is immutable after approval interaction creation", {
      code: "release_candidate_immutable",
      candidateId: candidate.id,
      status: candidate.status,
    });
  }
}

function candidateTargetKey(candidateId: string) {
  return `${RELEASE_CANDIDATE_CONFIRMATION_TARGET_PREFIX}${candidateId}`;
}

function buildAuditComment(eventType: string, candidate: CandidateRow, extra: Record<string, unknown> = {}) {
  const lines = [
    `Deploy-control audit: ${eventType}`,
    "",
    `- candidate_id: ${candidate.id}`,
    `- image_digest: ${candidate.imageDigest}`,
    `- environment: ${candidate.environment}`,
    `- target_host: ${candidate.targetHost}`,
    `- sequence: ${candidate.sequence}`,
  ];
  for (const [key, value] of Object.entries(extra)) {
    if (value == null) continue;
    lines.push(`- ${key}: ${String(value)}`);
  }
  return lines.join("\n");
}

function buildAuditMetadata(eventType: string, candidate: CandidateRow): IssueCommentMetadata {
  return {
    version: 1,
    sections: [{
      title: "Release Candidate Audit",
      rows: [
        { type: "key_value", label: "Event", value: eventType },
        { type: "key_value", label: "Candidate", value: candidate.id },
        { type: "key_value", label: "Secret fields", value: "omitted" },
      ],
    }],
  };
}

async function appendAudit(db: Db, args: {
  candidate: CandidateRow;
  eventType: string;
  actor: Actor;
  authorizationId?: string | null;
  payload?: Record<string, unknown>;
  commentExtra?: Record<string, unknown>;
}) {
  await db.insert(releaseCandidateAuditEvents).values({
    companyId: args.candidate.companyId,
    candidateId: args.candidate.id,
    authorizationId: args.authorizationId ?? null,
    issueId: args.candidate.sourceIssueId,
    actorAgentId: args.actor.agentId ?? null,
    actorUserId: args.actor.userId ?? null,
    eventType: args.eventType,
    payload: args.payload ?? {},
    redacted: true,
  });

  await db.insert(issueComments).values({
    companyId: args.candidate.companyId,
    issueId: args.candidate.sourceIssueId,
    authorAgentId: args.actor.agentId ?? null,
    authorUserId: args.actor.userId ?? null,
    authorType: args.actor.agentId ? "agent" : args.actor.userId ? "user" : "system",
    createdByRunId: args.actor.runId ?? null,
    body: buildAuditComment(args.eventType, args.candidate, args.commentExtra),
    metadata: buildAuditMetadata(args.eventType, args.candidate),
  });
}

export function verifyRelayArtifact(candidate: CandidateRow, artifact: RelayArtifactVerificationInput) {
  if (artifact.imageDigest !== candidate.imageDigest) {
    throw unprocessable("Relay artifact digest does not match approved candidate", {
      code: "release_candidate_wrong_digest",
    });
  }
  if (artifact.sbomHash !== candidate.sbomHash) {
    throw unprocessable("Relay artifact SBOM hash does not match approved candidate", {
      code: "release_candidate_wrong_sbom",
    });
  }
  if (normalizeSha256(artifact.signatureBundleSha256) !== normalizeSha256(candidate.signatureBundleSha256)) {
    throw unprocessable("Relay artifact signature bundle hash does not match approved candidate", {
      code: "release_candidate_wrong_signature_bundle",
    });
  }
  if (!artifact.signatureVerified) {
    throw unprocessable("Relay artifact signature is not verified", {
      code: "release_candidate_unsigned",
    });
  }
  if (!artifact.sbomVerified) {
    throw unprocessable("Relay artifact SBOM is not verified", {
      code: "release_candidate_unverified_sbom",
    });
  }
  if (!/^[a-f0-9]{64}$/i.test(normalizeSha256(artifact.tarballSha256))) {
    throw unprocessable("Relay artifact tarball SHA-256 is invalid", {
      code: "release_candidate_invalid_tarball_sha",
    });
  }
  if (!/^[a-f0-9]{64}$/i.test(normalizeSha256(artifact.signatureBundleSha256))) {
    throw unprocessable("Relay artifact signature bundle SHA-256 is invalid", {
      code: "release_candidate_invalid_signature_bundle_sha",
    });
  }
}

async function issueDeployAuthorizationForAcceptedInteraction(
  operationDb: Db,
  issueId: string,
  interaction: IssueThreadInteraction,
  actor: Actor,
  ttlMs: number,
) {
  if (interaction.kind !== "request_confirmation" || interaction.status !== "accepted") return null;
  const target = interaction.payload.target;
  if (!target || target.type !== "custom" || !target.key.startsWith(RELEASE_CANDIDATE_CONFIRMATION_TARGET_PREFIX)) {
    return null;
  }
  const candidateId = target.key.slice(RELEASE_CANDIDATE_CONFIRMATION_TARGET_PREFIX.length);
  const candidate = await operationDb
    .select()
    .from(releaseCandidates)
    .where(eq(releaseCandidates.id, candidateId))
    .then((rows) => rows[0] ?? null);
  if (!candidate || candidate.sourceIssueId !== issueId) {
    throw unprocessable("Release candidate approval target does not match the source issue");
  }
  if (candidate.approvalInteractionId !== interaction.id) {
    throw unprocessable("Release candidate approval interaction does not match candidate record");
  }
  if (target.revisionId !== candidate.imageDigest) {
    throw unprocessable("Release candidate approval digest does not match candidate record");
  }
  const existing = await operationDb
    .select()
    .from(releaseDeployAuthorizations)
    .where(and(
      eq(releaseDeployAuthorizations.candidateId, candidate.id),
      eq(releaseDeployAuthorizations.approvalInteractionId, interaction.id),
    ))
    .then((rows) => rows[0] ?? null);
  if (existing) {
    return {
      authorization: existing,
      token: null,
      alreadyIssued: true,
    };
  }

  const token = generateDeployToken();
  const expiresAt = new Date(Date.now() + ttlMs);
  const [authorization] = await operationDb.insert(releaseDeployAuthorizations).values({
    companyId: candidate.companyId,
    candidateId: candidate.id,
    approvalInteractionId: interaction.id,
    tokenHash: token.hash,
    tokenPrefix: token.prefix,
    targetHost: candidate.targetHost,
    imageDigest: candidate.imageDigest,
    environment: candidate.environment,
    sequence: candidate.sequence,
    expiresAt,
    createdByUserId: actor.userId ?? null,
  }).onConflictDoNothing({
    target: [releaseDeployAuthorizations.candidateId, releaseDeployAuthorizations.approvalInteractionId],
  }).returning();
  if (!authorization) {
    const concurrentAuthorization = await operationDb
      .select()
      .from(releaseDeployAuthorizations)
      .where(and(
        eq(releaseDeployAuthorizations.candidateId, candidate.id),
        eq(releaseDeployAuthorizations.approvalInteractionId, interaction.id),
      ))
      .then((rows) => rows[0] ?? null);
    if (!concurrentAuthorization) throw conflict("Failed to create deploy authorization");
    return {
      authorization: concurrentAuthorization,
      token: null,
      alreadyIssued: true,
    };
  }

  const [approvedCandidate] = await operationDb.update(releaseCandidates).set({
    status: "approved",
    approvedByUserId: actor.userId ?? null,
    approvedAt: new Date(),
    updatedAt: new Date(),
  }).where(and(
    eq(releaseCandidates.id, candidate.id),
    eq(releaseCandidates.status, "approval_requested"),
    eq(releaseCandidates.approvalInteractionId, interaction.id),
  )).returning();
  if (!approvedCandidate) throw conflict("Failed to approve release candidate");
  await appendAudit(operationDb, {
    candidate: approvedCandidate,
    actor,
    authorizationId: authorization.id,
    eventType: "deploy_authorization_issued",
    payload: {
      authorizationId: authorization.id,
      tokenPrefix: token.prefix,
      targetHost: authorization.targetHost,
      digest: authorization.imageDigest,
      environment: authorization.environment,
      sequence: authorization.sequence,
      expiresAt: authorization.expiresAt.toISOString(),
    },
    commentExtra: {
      authorization_id: authorization.id,
      token_prefix: token.prefix,
      expires_at: authorization.expiresAt.toISOString(),
    },
  });
  return { authorization, token: token.secret, alreadyIssued: false };
}

export function releaseCandidateService(db: Db) {
  async function getById(id: string) {
    return db.select().from(releaseCandidates).where(eq(releaseCandidates.id, id)).then((rows) => rows[0] ?? null);
  }

  async function getAuthorizationById(id: string) {
    return db
      .select()
      .from(releaseDeployAuthorizations)
      .where(eq(releaseDeployAuthorizations.id, id))
      .then((rows) => rows[0] ?? null);
  }

  return {
    getById,

    create: async (input: CreateReleaseCandidateInput, actor: Actor) => {
      const [candidate] = await db.insert(releaseCandidates).values({
        ...input,
        createdByAgentId: actor.agentId ?? null,
        createdByRunId: actor.runId ?? null,
        documentRevisionId: input.documentRevisionId ?? null,
        metadata: input.metadata ?? {},
      }).returning();
      if (!candidate) throw conflict("Failed to create release candidate");
      await appendAudit(db, {
        candidate,
        actor,
        eventType: "candidate_created",
        payload: {
          digest: candidate.imageDigest,
          signatureBundleSha256: candidate.signatureBundleSha256,
          environment: candidate.environment,
          targetHost: candidate.targetHost,
          sequence: candidate.sequence,
        },
      });
      return candidate;
    },

    updateMutable: async (candidateId: string, data: UpdateReleaseCandidateInput, actor: Actor) => {
      const candidate = await getById(candidateId);
      if (!candidate) throw notFound("Release candidate not found");
      assertCandidateMutable(candidate);
      const [updated] = await db.update(releaseCandidates).set({
        ...data,
        documentRevisionId: data.documentRevisionId ?? candidate.documentRevisionId,
        metadata: data.metadata ?? candidate.metadata,
        updatedAt: new Date(),
      }).where(and(
        eq(releaseCandidates.id, candidateId),
        eq(releaseCandidates.status, "candidate_created"),
        isNull(releaseCandidates.approvalInteractionId),
      )).returning();
      if (!updated) {
        throw conflict("Release candidate is immutable after approval interaction creation", {
          code: "release_candidate_immutable",
          candidateId,
        });
      }
      await appendAudit(db, { candidate: updated, actor, eventType: "candidate_updated" });
      return updated;
    },

    markApprovalInteractionCreated: async (
      candidateId: string,
      interaction: IssueThreadInteraction,
      actor: Actor,
    ) => {
      const candidate = await getById(candidateId);
      if (!candidate) throw notFound("Release candidate not found");
      assertCandidateMutable(candidate);
      if (interaction.kind !== "request_confirmation") {
        throw unprocessable("Release candidate approval must use request_confirmation");
      }
      const target = interaction.payload.target;
      if (
        !target
        || target.type !== "custom"
        || target.key !== candidateTargetKey(candidate.id)
        || target.revisionId !== candidate.imageDigest
      ) {
        throw unprocessable("Release candidate approval target must bind the candidate id and image digest");
      }
      const [updated] = await db.update(releaseCandidates).set({
        approvalInteractionId: interaction.id,
        status: "approval_requested",
        updatedAt: new Date(),
      }).where(and(
        eq(releaseCandidates.id, candidateId),
        eq(releaseCandidates.status, "candidate_created"),
        isNull(releaseCandidates.approvalInteractionId),
      )).returning();
      if (!updated) {
        throw conflict("Release candidate changed while creating its approval interaction; retry the request", {
          code: "release_candidate_approval_race",
          candidateId,
        });
      }
      await appendAudit(db, {
        candidate: updated,
        actor,
        eventType: "approval_requested",
        payload: {
          interactionId: interaction.id,
          digest: updated.imageDigest,
          documentRevisionId: updated.documentRevisionId,
        },
        commentExtra: {
          interaction_id: interaction.id,
          document_revision_id: updated.documentRevisionId,
        },
      });
      return updated;
    },

    buildApprovalInteractionInput: (candidate: CandidateRow) => ({
      kind: "request_confirmation" as const,
      idempotencyKey: `release-candidate:${candidate.id}:approval:${candidate.imageDigest}`,
      title: `Approve scanner release ${candidate.sequence}`,
      summary: `Founder approval for ${candidate.targetHost} ${candidate.environment} digest ${candidate.imageDigest}`,
      continuationPolicy: "wake_assignee" as const,
      payload: {
        version: 1 as const,
        prompt: `Approve scanner deploy candidate ${candidate.sequence} for ${candidate.environment} on ${candidate.targetHost}?`,
        acceptLabel: "Approve deploy",
        rejectLabel: "Reject",
        allowDeclineReason: true,
        detailsMarkdown: [
          `Candidate: ${candidate.id}`,
          `Commit: ${candidate.commitSha}`,
          `Image digest: ${candidate.imageDigest}`,
          `SBOM hash: ${candidate.sbomHash}`,
          `Signature bundle SHA-256: ${candidate.signatureBundleSha256}`,
          `Signature bundle: ${candidate.signatureBundleRef}`,
          `Provenance: ${candidate.provenanceRef}`,
          `Workflow: ${candidate.workflowRunUrl}`,
          `Document revision: ${candidate.documentRevisionId ?? "not set"}`,
        ].join("\n\n"),
        target: {
          type: "custom" as const,
          key: candidateTargetKey(candidate.id),
          revisionId: candidate.imageDigest,
          label: "Release candidate digest",
        },
      },
    }),

    handleAcceptedInteraction: async (
      issueId: string,
      interaction: IssueThreadInteraction,
      actor: Actor,
      ttlMs = DEFAULT_AUTH_TTL_MS,
    ) => db.transaction(async (tx) => issueDeployAuthorizationForAcceptedInteraction(
      tx as unknown as Db,
      issueId,
      interaction,
      actor,
      ttlMs,
    )),

    handleAcceptedInteractionInTransaction: async (
      issueId: string,
      interaction: IssueThreadInteraction,
      actor: Actor,
      ttlMs = DEFAULT_AUTH_TTL_MS,
    ) => issueDeployAuthorizationForAcceptedInteraction(db, issueId, interaction, actor, ttlMs),

    verifyRelayAuthorization: async (authorizationId: string, token: string, artifact: RelayArtifactVerificationInput) => {
      const authorization = await getAuthorizationById(authorizationId);
      if (!authorization) throw notFound("Deploy authorization not found");
      const candidate = await getById(authorization.candidateId);
      if (!candidate) throw notFound("Release candidate not found");
      const providedHash = sha256(token);
      if (!tokenHashMatches(providedHash, authorization.tokenHash)) {
        throw unauthorized("Deploy authorization token is invalid");
      }
      if (authorization.expiresAt.getTime() <= Date.now()) {
        throw unauthorized("Deploy authorization token is expired");
      }
      if (authorization.usedAt) {
        throw conflict("Deploy authorization token has already been used", {
          code: "release_candidate_token_used",
        });
      }
      if (
        authorization.targetHost !== candidate.targetHost
        || authorization.imageDigest !== candidate.imageDigest
        || authorization.environment !== candidate.environment
        || authorization.sequence !== candidate.sequence
      ) {
        throw conflict("Deploy authorization scope no longer matches release candidate");
      }
      verifyRelayArtifact(candidate, artifact);
      return { authorization, candidate };
    },

    getApprovedLease: async (authorizationId: string, token: string) => {
      const authorization = await getAuthorizationById(authorizationId);
      if (!authorization) throw notFound("Deploy authorization not found");
      const candidate = await getById(authorization.candidateId);
      if (!candidate) throw notFound("Release candidate not found");
      const providedHash = sha256(token);
      if (!tokenHashMatches(providedHash, authorization.tokenHash)) {
        throw unauthorized("Deploy authorization token is invalid");
      }
      if (authorization.expiresAt.getTime() <= Date.now()) {
        throw unauthorized("Deploy authorization token is expired");
      }
      if (
        authorization.targetHost !== candidate.targetHost
        || authorization.imageDigest !== candidate.imageDigest
        || authorization.environment !== candidate.environment
        || authorization.sequence !== candidate.sequence
      ) {
        throw conflict("Deploy authorization scope no longer matches release candidate");
      }
      return { authorization, candidate };
    },

    stageRelayArtifact: async (
      authorizationId: string,
      token: string,
      artifact: RelayArtifactInput,
      assetIds: { artifactAssetId: string; signatureBundleAssetId: string },
      actor: Actor,
    ) => {
      const { authorization, candidate } = await releaseCandidateService(db).verifyRelayAuthorization(authorizationId, token, artifact);
      const now = new Date();
      return db.transaction(async (tx) => {
        const transactionDb = tx as unknown as Db;
        const [updatedAuth] = await tx.update(releaseDeployAuthorizations).set({
          usedAt: now,
          leaseArtifactAssetId: assetIds.artifactAssetId,
          leaseSignatureBundleAssetId: assetIds.signatureBundleAssetId,
          leaseIssuedAt: now,
          updatedAt: now,
        }).where(and(
          eq(releaseDeployAuthorizations.id, authorization.id),
          eq(releaseDeployAuthorizations.tokenHash, authorization.tokenHash),
          isNull(releaseDeployAuthorizations.usedAt),
        )).returning();
        if (!updatedAuth) {
          throw conflict("Deploy authorization token has already been used", {
            code: "release_candidate_token_used",
          });
        }
        const [updatedCandidate] = await tx.update(releaseCandidates).set({
          status: "staged",
          stagedArtifactAssetId: assetIds.artifactAssetId,
          stagedArtifactSha256: normalizeSha256(artifact.tarballSha256),
          stagedSignatureBundleAssetId: assetIds.signatureBundleAssetId,
          stagedSignatureBundleSha256: normalizeSha256(artifact.signatureBundleSha256),
          stagedAt: now,
          updatedAt: now,
        }).where(eq(releaseCandidates.id, candidate.id)).returning();
        if (!updatedCandidate) throw conflict("Failed to stage release candidate");
        await appendAudit(transactionDb, {
          candidate: updatedCandidate,
          actor,
          authorizationId: authorization.id,
          eventType: "relay_artifact_staged",
          payload: {
            authorizationId: authorization.id,
            artifactAssetId: assetIds.artifactAssetId,
            signatureBundleAssetId: assetIds.signatureBundleAssetId,
            tarballSha256: normalizeSha256(artifact.tarballSha256),
            signatureBundleSha256: normalizeSha256(artifact.signatureBundleSha256),
            digest: artifact.imageDigest,
            sbomHash: artifact.sbomHash,
          },
          commentExtra: {
            authorization_id: authorization.id,
            artifact_asset_id: assetIds.artifactAssetId,
            signature_bundle_asset_id: assetIds.signatureBundleAssetId,
            tarball_sha256: normalizeSha256(artifact.tarballSha256),
            signature_bundle_sha256: normalizeSha256(artifact.signatureBundleSha256),
          },
        });
        return updatedAuth as AuthorizationRow;
      });
    },

    recordDeployEvent: async (input: DeployRecordInput, actor: Actor) => {
      const { authorization, candidate } = await releaseCandidateService(db).getApprovedLease(input.authorizationId, input.token);
      const eventType = `deploy_${input.status}`;
      await appendAudit(db, {
        candidate,
        actor,
        authorizationId: authorization.id,
        eventType,
        payload: {
          status: input.status,
          commitSha: input.commitSha ?? candidate.commitSha,
          healthStatus: input.healthStatus ?? null,
          rollbackReason: input.rollbackReason ?? null,
          metadata: input.metadata ?? {},
        },
        commentExtra: {
          authorization_id: authorization.id,
          status: input.status,
          commit_sha: input.commitSha ?? candidate.commitSha,
          health_status: input.healthStatus ?? null,
          rollback_reason: input.rollbackReason ?? null,
          message: input.message ?? null,
        },
      });
      return { authorization, candidate, eventType };
    },
  };
}
