import { createHash } from "node:crypto";
import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";
import { validate } from "../middleware/validate.js";
import { badRequest, notFound, unauthorized } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { assetService } from "../services/assets.js";
import { issueService } from "../services/issues.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { releaseCandidateService } from "../services/release-candidates.js";

const digestSchema = z.string().trim().min(12).max(300);
const sha256Schema = z.string().trim().regex(/^(sha256:)?[a-fA-F0-9]{64}$/, "Expected SHA-256 hash");

const createReleaseCandidateSchema = z.object({
  sourceIssueId: z.string().uuid(),
  commitSha: z.string().trim().min(7).max(80),
  imageDigest: digestSchema,
  signatureBundleRef: z.string().trim().min(1).max(2000),
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
  provenanceRef: z.string().trim().min(1).max(2000).optional(),
  workflowRunUrl: z.string().trim().url().max(2000).optional(),
  documentRevisionId: z.string().trim().min(1).max(255).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
}).strict();

const createApprovalInteractionSchema = z.object({}).strict();
const DEPLOY_TOKEN_HEADER = "x-paperclip-deploy-token";

const approvedLeaseQuerySchema = z.object({
  authorizationId: z.string().uuid(),
}).strict();

const stageRelayArtifactSchema = z.object({
  imageDigest: digestSchema,
  sbomHash: sha256Schema,
  signatureVerified: z.boolean(),
  sbomVerified: z.boolean(),
  tarballSha256: sha256Schema,
  tarballBase64: z.string().trim().min(1),
  originalFilename: z.string().trim().min(1).max(255).nullable().optional(),
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

export function releaseCandidateRoutes(db: Db, storage: StorageService) {
  const router = Router();
  const candidates = releaseCandidateService(db);

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
    assertCompanyAccess(req, candidate.companyId);
    res.json({
      authorizationId: authorization.id,
      candidateId: candidate.id,
      sourceIssueId: candidate.sourceIssueId,
      commitSha: candidate.commitSha,
      imageDigest: candidate.imageDigest,
      signatureBundleRef: candidate.signatureBundleRef,
      provenanceRef: candidate.provenanceRef,
      sbomHash: candidate.sbomHash,
      workflowRunUrl: candidate.workflowRunUrl,
      targetHost: authorization.targetHost,
      environment: authorization.environment,
      sequence: authorization.sequence,
      expiresAt: authorization.expiresAt,
      stageRelayArtifactPath: `/api/release-deploy-authorizations/${authorization.id}/stage-relay-artifact`,
      deployRecordPath: "/api/release-candidates/deploy-records",
      stagedArtifactPath: authorization.leaseArtifactAssetId
        ? `/api/assets/${authorization.leaseArtifactAssetId}/content`
        : null,
      stagedArtifactSha256: candidate.stagedArtifactSha256,
      tarballSha256: candidate.stagedArtifactSha256,
      approvalInteractionId: authorization.approvalInteractionId,
    });
  });

  router.post(
    "/release-candidates/deploy-records",
    validate(deployRecordSchema),
    async (req, res) => {
      const actor = getActorInfo(req);
      const token = readDeployTokenHeader(req);
      const result = await candidates.recordDeployEvent({ ...req.body, token }, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
        runId: actor.runId,
      });
      assertCompanyAccess(req, result.candidate.companyId);
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
    if (!candidate) throw notFound("Release candidate not found");
    assertCompanyAccess(req, candidate.companyId);
    res.json(candidate);
  });

  router.patch(
    "/release-candidates/:candidateId",
    validate(updateReleaseCandidateSchema),
    async (req, res) => {
      const candidate = await candidates.getById(req.params.candidateId as string);
      if (!candidate) throw notFound("Release candidate not found");
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
      if (!candidate) throw notFound("Release candidate not found");
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
      const tarballBytes = Buffer.from(body.tarballBase64, "base64");
      if (tarballBytes.length <= 0) throw badRequest("tarballBase64 decoded to an empty artifact");
      const actualTarballSha = createHash("sha256").update(tarballBytes).digest("hex");
      const expectedTarballSha = body.tarballSha256.replace(/^sha256:/, "").toLowerCase();
      if (actualTarballSha !== expectedTarballSha) throw badRequest("tarballBase64 does not match tarballSha256");

      const actor = getActorInfo(req);
      const { candidate } = await candidates.verifyRelayAuthorization(req.params.authorizationId as string, token, {
        imageDigest: body.imageDigest,
        sbomHash: body.sbomHash,
        signatureVerified: body.signatureVerified,
        sbomVerified: body.sbomVerified,
        tarballSha256: expectedTarballSha,
      });
      assertCompanyAccess(req, candidate.companyId);
      const stored = await storage.putFile({
        companyId: candidate.companyId,
        namespace: "release-candidates",
        originalFilename: body.originalFilename ?? "scanner-release-candidate.tar",
        contentType: "application/x-tar",
        body: tarballBytes,
      });
      const asset = await assetService(db).create(candidate.companyId, {
        provider: stored.provider,
        objectKey: stored.objectKey,
        contentType: stored.contentType,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        originalFilename: stored.originalFilename,
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
          tarballBytes,
          originalFilename: body.originalFilename ?? null,
        },
        asset.id,
        {
          agentId: actor.agentId,
          userId: actor.actorType === "user" ? actor.actorId : null,
          runId: actor.runId,
        },
      );
      res.status(201).json({
        authorizationId: authorization.id,
        candidateId: authorization.candidateId,
        lease: {
          assetId: authorization.leaseArtifactAssetId,
          artifactPath: `/api/assets/${authorization.leaseArtifactAssetId}/content`,
          targetHost: authorization.targetHost,
          imageDigest: authorization.imageDigest,
          environment: authorization.environment,
          sequence: authorization.sequence,
          leaseIssuedAt: authorization.leaseIssuedAt,
        },
      });
    },
  );

  return router;
}
