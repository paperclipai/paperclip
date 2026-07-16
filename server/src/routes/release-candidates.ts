import { createHash } from "node:crypto";
import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";
import { validate } from "../middleware/validate.js";
import { badRequest, conflict, HttpError, notFound, unauthorized } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { assertCompanyAccess, getActorInfo, hasCompanyAccess } from "./authz.js";
import { assetService } from "../services/assets.js";
import { issueService } from "../services/issues.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { releaseCandidateService } from "../services/release-candidates.js";
import { DEFAULT_JSON_BODY_LIMIT_BYTES } from "../http/body-limits.js";

const digestSchema = z.string().trim().min(12).max(300);
const sha256Schema = z.string().trim().regex(/^(sha256:)?[a-fA-F0-9]{64}$/, "Expected SHA-256 hash");

const createReleaseCandidateSchema = z.object({
  sourceIssueId: z.string().uuid(),
  commitSha: z.string().trim().min(7).max(80),
  imageDigest: digestSchema,
  signatureBundleRef: z.string().trim().min(1).max(2000),
  signatureBundleSha256: sha256Schema,
  provenanceRef: z.string().trim().min(1).max(2000),
  sbomHash: sha256Schema,
  workflowRunUrl: z.string().trim().url().max(2000),
  environment: z.string().trim().min(1).max(120),
  targetHost: z.string().trim().min(1).max(255),
  sequence: z.number().int().positive(),
  documentRevisionId: z.string().trim().min(1).max(255).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
}).strict();

const updateReleaseCandidateSchema = z.object({
  signatureBundleRef: z.string().trim().min(1).max(2000).optional(),
  signatureBundleSha256: sha256Schema.optional(),
  provenanceRef: z.string().trim().min(1).max(2000).optional(),
  workflowRunUrl: z.string().trim().url().max(2000).optional(),
  documentRevisionId: z.string().trim().min(1).max(255).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
}).strict();

const createApprovalInteractionSchema = z.object({}).strict();
const DEPLOY_TOKEN_HEADER = "x-paperclip-deploy-token";
const MAX_RELAY_BASE64_CHARS = DEFAULT_JSON_BODY_LIMIT_BYTES;
const MAX_RELAY_DECODED_BYTES = Math.floor(MAX_RELAY_BASE64_CHARS / 4) * 3;

const approvedLeaseQuerySchema = z.object({
  authorizationId: z.string().uuid(),
}).strict();

const stageRelayArtifactSchema = z.object({
  imageDigest: digestSchema,
  sbomHash: sha256Schema,
  signatureVerified: z.boolean(),
  sbomVerified: z.boolean(),
  tarballSha256: sha256Schema,
  tarballBase64: z.string().trim().min(1).max(MAX_RELAY_BASE64_CHARS),
  signatureBundleSha256: sha256Schema,
  signatureBundleBase64: z.string().trim().min(1).max(MAX_RELAY_BASE64_CHARS),
  originalFilename: z.string().trim().min(1).max(255).nullable().optional(),
  signatureBundleFilename: z.string().trim().min(1).max(255).nullable().optional(),
}).strict();

const deployRecordSchema = z.object({
  authorizationId: z.string().uuid(),
  status: z.enum(["started", "succeeded", "failed", "rolled_back"]),
  message: z.string().trim().max(2000).nullable().optional(),
  commitSha: z.string().trim().min(7).max(80).nullable().optional(),
  healthStatus: z.string().trim().max(200).nullable().optional(),
  rollbackReason: z.string().trim().max(2000).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
}).strict();

function readDeployTokenHeader(req: Request) {
  const token = req.header(DEPLOY_TOKEN_HEADER)?.trim();
  if (!token) throw unauthorized("Missing deploy authorization token header");
  return token;
}

function normalizeSha256(value: string) {
  return value.replace(/^sha256:/i, "").toLowerCase();
}

function decodeRelayPayload(value: string, fieldName: string) {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length <= 0) throw badRequest(`${fieldName} decoded to an empty artifact`);
  if (bytes.length > MAX_RELAY_DECODED_BYTES) {
    throw badRequest(`${fieldName} decoded payload exceeds ${MAX_RELAY_DECODED_BYTES} bytes`);
  }
  return bytes;
}

export function releaseCandidateRoutes(db: Db, storage: StorageService) {
  const router = Router();
  const candidates = releaseCandidateService(db);
  const assets = assetService(db);

  async function streamRelayAsset(
    res: Response,
    companyId: string,
    assetId: string | null,
    missingMessage: string,
    filename: string,
  ) {
    if (!assetId) throw conflict(missingMessage);
    const asset = await assets.getById(assetId);
    if (!asset || asset.companyId !== companyId) throw notFound("Release relay asset not found");

    const object = await storage.getObject(asset.companyId, asset.objectKey);
    const responseContentType = asset.contentType || object.contentType || "application/octet-stream";
    res.setHeader("Content-Type", responseContentType);
    res.setHeader("Content-Length", String(asset.byteSize || object.contentLength || 0));
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `attachment; filename="${filename.replaceAll("\"", "")}"`);
    object.stream.pipe(res);
  }

  router.post(
    "/companies/:companyId/release-candidates",
    validate(createReleaseCandidateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const sourceIssue = await issueService(db).getById(req.body.sourceIssueId);
      if (!sourceIssue || sourceIssue.companyId !== companyId) {
        throw notFound("Source issue not found");
      }
      const candidate = await candidates.create({
        ...req.body,
        companyId,
      }, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
        runId: actor.runId,
      });
      res.status(201).json(candidate);
    },
  );

  router.get("/release-candidates/approved-lease", async (req, res) => {
    const query = approvedLeaseQuerySchema.parse(req.query);
    const token = readDeployTokenHeader(req);
    const { authorization, candidate } = await candidates.getApprovedLease(query.authorizationId, token);
    if (!hasCompanyAccess(req, candidate.companyId)) throw notFound("Release deploy authorization not found");
    assertCompanyAccess(req, candidate.companyId);
    res.json({
      authorizationId: authorization.id,
      candidateId: candidate.id,
      sourceIssueId: candidate.sourceIssueId,
      commitSha: candidate.commitSha,
      imageDigest: candidate.imageDigest,
      provenanceRef: candidate.provenanceRef,
      signatureBundleSha256: candidate.signatureBundleSha256,
      sbomHash: candidate.sbomHash,
      workflowRunUrl: candidate.workflowRunUrl,
      targetHost: authorization.targetHost,
      environment: authorization.environment,
      sequence: authorization.sequence,
      expiresAt: authorization.expiresAt,
      stageRelayArtifactPath: `/api/release-deploy-authorizations/${authorization.id}/stage-relay-artifact`,
      deployRecordPath: "/api/release-candidates/deploy-records",
      stagedArtifactPath: authorization.leaseArtifactAssetId
        ? `/api/release-deploy-authorizations/${authorization.id}/staged-artifact`
        : null,
      stagedArtifactSha256: candidate.stagedArtifactSha256,
      stagedSignatureBundlePath: authorization.leaseSignatureBundleAssetId
        ? `/api/release-deploy-authorizations/${authorization.id}/staged-signature-bundle`
        : null,
      stagedSignatureBundleSha256: candidate.stagedSignatureBundleSha256,
      tarballSha256: candidate.stagedArtifactSha256,
      approvalInteractionId: authorization.approvalInteractionId,
    });
  });

  router.post(
    "/release-candidates/deploy-records",
    validate(deployRecordSchema),
    async (req, res) => {
      const token = readDeployTokenHeader(req);
      const { candidate } = await candidates.getApprovedLease(req.body.authorizationId, token);
      if (!hasCompanyAccess(req, candidate.companyId)) throw notFound("Release deploy authorization not found");
      assertCompanyAccess(req, candidate.companyId);
      const actor = getActorInfo(req);
      const result = await candidates.recordDeployEvent({ ...req.body, token }, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
        runId: actor.runId,
      });
      res.status(201).json({
        ok: true,
        eventType: result.eventType,
        authorizationId: result.authorization.id,
        candidateId: result.candidate.id,
        sourceIssueId: result.candidate.sourceIssueId,
      });
    },
  );

  router.get("/release-candidates/:candidateId", async (req, res) => {
    const candidate = await candidates.getById(req.params.candidateId as string);
    if (!candidate || !hasCompanyAccess(req, candidate.companyId)) throw notFound("Release candidate not found");
    assertCompanyAccess(req, candidate.companyId);
    res.json(candidate);
  });

  router.patch(
    "/release-candidates/:candidateId",
    validate(updateReleaseCandidateSchema),
    async (req, res) => {
      const candidate = await candidates.getById(req.params.candidateId as string);
      if (!candidate || !hasCompanyAccess(req, candidate.companyId)) throw notFound("Release candidate not found");
      assertCompanyAccess(req, candidate.companyId);
      const actor = getActorInfo(req);
      const updated = await candidates.updateMutable(candidate.id, req.body, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
        runId: actor.runId,
      });
      res.json(updated);
    },
  );

  router.post(
    "/release-candidates/:candidateId/approval-interaction",
    validate(createApprovalInteractionSchema),
    async (req, res) => {
      const candidate = await candidates.getById(req.params.candidateId as string);
      if (!candidate || !hasCompanyAccess(req, candidate.companyId)) throw notFound("Release candidate not found");
      assertCompanyAccess(req, candidate.companyId);
      const actor = getActorInfo(req);
      const sourceIssue = await issueService(db).getById(candidate.sourceIssueId);
      if (!sourceIssue) throw notFound("Source issue not found");
      const interactionInput = candidates.buildApprovalInteractionInput(candidate);
      const interaction = await issueThreadInteractionService(db).create(sourceIssue, interactionInput, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });
      const updated = await candidates.markApprovalInteractionCreated(candidate.id, interaction, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
        runId: actor.runId,
      });
      res.status(201).json({ candidate: updated, interaction });
    },
  );

  router.post(
    "/release-deploy-authorizations/:authorizationId/stage-relay-artifact",
    validate(stageRelayArtifactSchema),
    async (req, res) => {
      const body = req.body as z.infer<typeof stageRelayArtifactSchema>;
      const token = readDeployTokenHeader(req);
      const expectedTarballSha = normalizeSha256(body.tarballSha256);
      const expectedSignatureBundleSha = normalizeSha256(body.signatureBundleSha256);
      const { candidate } = await candidates.verifyRelayAuthorization(req.params.authorizationId as string, token, {
        imageDigest: body.imageDigest,
        sbomHash: body.sbomHash,
        signatureVerified: body.signatureVerified,
        sbomVerified: body.sbomVerified,
        tarballSha256: expectedTarballSha,
        signatureBundleSha256: expectedSignatureBundleSha,
      });
      if (!hasCompanyAccess(req, candidate.companyId)) throw notFound("Release deploy authorization not found");
      assertCompanyAccess(req, candidate.companyId);

      const tarballBytes = decodeRelayPayload(body.tarballBase64, "tarballBase64");
      const actualTarballSha = createHash("sha256").update(tarballBytes).digest("hex");
      if (actualTarballSha !== expectedTarballSha) throw badRequest("tarballBase64 does not match tarballSha256");
      const signatureBundleBytes = decodeRelayPayload(body.signatureBundleBase64, "signatureBundleBase64");
      const actualSignatureBundleSha = createHash("sha256").update(signatureBundleBytes).digest("hex");
      if (actualSignatureBundleSha !== expectedSignatureBundleSha) {
        throw badRequest("signatureBundleBase64 does not match signatureBundleSha256");
      }

      const actor = getActorInfo(req);
      const storedArtifact = await storage.putFile({
        companyId: candidate.companyId,
        namespace: "release-candidates",
        originalFilename: body.originalFilename ?? "scanner-release-candidate.tar",
        contentType: "application/x-tar",
        body: tarballBytes,
      });
      const artifactAsset = await assets.create(candidate.companyId, {
        provider: storedArtifact.provider,
        objectKey: storedArtifact.objectKey,
        contentType: storedArtifact.contentType,
        byteSize: storedArtifact.byteSize,
        sha256: storedArtifact.sha256,
        originalFilename: storedArtifact.originalFilename,
        createdByAgentId: actor.agentId,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      });
      const storedSignatureBundle = await storage.putFile({
        companyId: candidate.companyId,
        namespace: "release-candidates",
        originalFilename: body.signatureBundleFilename ?? "scanner-release-candidate.sigstore.json",
        contentType: "application/vnd.dev.sigstore.bundle+json",
        body: signatureBundleBytes,
      });
      const signatureBundleAsset = await assets.create(candidate.companyId, {
        provider: storedSignatureBundle.provider,
        objectKey: storedSignatureBundle.objectKey,
        contentType: storedSignatureBundle.contentType,
        byteSize: storedSignatureBundle.byteSize,
        sha256: storedSignatureBundle.sha256,
        originalFilename: storedSignatureBundle.originalFilename,
        createdByAgentId: actor.agentId,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      });
      const authorization = await candidates.stageRelayArtifact(
        req.params.authorizationId as string,
        token,
        {
          imageDigest: body.imageDigest,
          sbomHash: body.sbomHash,
          signatureVerified: body.signatureVerified,
          sbomVerified: body.sbomVerified,
          tarballSha256: expectedTarballSha,
          signatureBundleSha256: expectedSignatureBundleSha,
          tarballBytes,
          signatureBundleBytes,
          originalFilename: body.originalFilename ?? null,
          signatureBundleFilename: body.signatureBundleFilename ?? null,
        },
        {
          artifactAssetId: artifactAsset.id,
          signatureBundleAssetId: signatureBundleAsset.id,
        },
        {
          agentId: actor.agentId,
          userId: actor.actorType === "user" ? actor.actorId : null,
          runId: actor.runId,
        },
      ).catch(async (err: unknown) => {
        if (err instanceof HttpError && err.status === 409) {
          const stagedAssets = [
            { assetId: artifactAsset.id, objectKey: storedArtifact.objectKey },
            { assetId: signatureBundleAsset.id, objectKey: storedSignatureBundle.objectKey },
          ];
          for (const stagedAsset of stagedAssets) {
            try {
              await storage.deleteObject(candidate.companyId, stagedAsset.objectKey);
            } catch (cleanupError) {
              logger.warn({
                err: cleanupError,
                authorizationId: req.params.authorizationId,
                objectKey: stagedAsset.objectKey,
              }, "failed to delete relay storage object after staging conflict");
            }
            try {
              await assets.remove(candidate.companyId, stagedAsset.assetId);
            } catch (cleanupError) {
              logger.warn({
                err: cleanupError,
                authorizationId: req.params.authorizationId,
                assetId: stagedAsset.assetId,
              }, "failed to delete relay asset row after staging conflict");
            }
          }
        }
        throw err;
      });
      res.status(201).json({
        authorizationId: authorization.id,
        candidateId: authorization.candidateId,
        lease: {
          assetId: authorization.leaseArtifactAssetId,
          signatureBundleAssetId: authorization.leaseSignatureBundleAssetId,
          artifactPath: `/api/release-deploy-authorizations/${authorization.id}/staged-artifact`,
          signatureBundlePath: `/api/release-deploy-authorizations/${authorization.id}/staged-signature-bundle`,
          targetHost: authorization.targetHost,
          imageDigest: authorization.imageDigest,
          environment: authorization.environment,
          sequence: authorization.sequence,
          leaseIssuedAt: authorization.leaseIssuedAt,
        },
      });
    },
  );

  router.get("/release-deploy-authorizations/:authorizationId/staged-artifact", async (req, res) => {
    const token = readDeployTokenHeader(req);
    const { authorization, candidate } = await candidates.getApprovedLease(req.params.authorizationId as string, token);
    if (!hasCompanyAccess(req, candidate.companyId)) throw notFound("Release deploy authorization not found");
    assertCompanyAccess(req, candidate.companyId);
    await streamRelayAsset(
      res,
      candidate.companyId,
      authorization.leaseArtifactAssetId,
      "Release candidate artifact has not been staged",
      "scanner-release-candidate.tar",
    );
  });

  router.get("/release-deploy-authorizations/:authorizationId/staged-signature-bundle", async (req, res) => {
    const token = readDeployTokenHeader(req);
    const { authorization, candidate } = await candidates.getApprovedLease(req.params.authorizationId as string, token);
    if (!hasCompanyAccess(req, candidate.companyId)) throw notFound("Release deploy authorization not found");
    assertCompanyAccess(req, candidate.companyId);
    await streamRelayAsset(
      res,
      candidate.companyId,
      authorization.leaseSignatureBundleAssetId,
      "Release candidate signature bundle has not been staged",
      "scanner-release-candidate.sigstore.json",
    );
  });

  return router;
}
