import { createHash } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { releaseCandidateRoutes } from "../routes/release-candidates.js";

const mockAssetService = vi.hoisted(() => ({
  create: vi.fn(),
}));

const mockReleaseCandidateService = vi.hoisted(() => ({
  getApprovedLease: vi.fn(),
  recordDeployEvent: vi.fn(),
  verifyRelayAuthorization: vi.fn(),
  stageRelayArtifact: vi.fn(),
  recordDeployReceipt: vi.fn(),
}));

vi.mock("../services/release-candidates.js", async () => {
  const actual = await vi.importActual<typeof import("../services/release-candidates.js")>(
    "../services/release-candidates.js",
  );
  return {
    ...actual,
    releaseCandidateService: () => mockReleaseCandidateService,
  };
});

vi.mock("../services/assets.js", () => ({
  assetService: () => mockAssetService,
}));

const companyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function createApp(beforeRoutes?: express.RequestHandler) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "agent",
      source: "agent_jwt",
      agentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      companyId,
      runId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    };
    next();
  });
  if (beforeRoutes) app.use(beforeRoutes);
  app.use("/api", releaseCandidateRoutes({} as never, {} as never));
  app.use(errorHandler);
  return app;
}

describe("release candidate routes", () => {
  beforeEach(() => {
    mockReleaseCandidateService.getApprovedLease.mockReset();
    mockReleaseCandidateService.recordDeployEvent.mockReset();
    mockReleaseCandidateService.verifyRelayAuthorization.mockReset();
    mockReleaseCandidateService.stageRelayArtifact.mockReset();
    mockReleaseCandidateService.recordDeployReceipt.mockReset();
    mockAssetService.create.mockReset();
  });

  it("returns deploy-agent lease and candidate fields for approved leases", async () => {
    const authorizationId = "99999999-9999-4999-8999-999999999999";
    const approvalInteractionId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const stagedArtifactSha256 = "4444444444444444444444444444444444444444444444444444444444444444";
    mockReleaseCandidateService.getApprovedLease.mockResolvedValue({
      authorization: {
        id: authorizationId,
        candidateId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        approvalInteractionId,
        targetHost: "srv1749248",
        imageDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        environment: "production",
        sequence: 42,
        expiresAt: new Date("2026-07-14T14:00:00.000Z"),
        leaseArtifactAssetId: "77777777-7777-4777-8777-777777777777",
      },
      candidate: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        companyId,
        sourceIssueId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        commitSha: "abc1234567890",
        imageDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        signatureBundleRef: "oci://registry.example/scanner/signature",
        signatureBundleSha256: "3333333333333333333333333333333333333333333333333333333333333333",
        provenanceRef: "https://github.example/workflows/1/provenance",
        sbomHash: "2222222222222222222222222222222222222222222222222222222222222222",
        workflowRunUrl: "https://github.example/workflows/1",
        stagedArtifactSha256,
        stagedArtifactAssetId: "77777777-7777-4777-8777-777777777777",
        stagedSignatureBundleAssetId: "88888888-8888-4888-8888-888888888888",
        stagedSignatureBundleSha256: "3333333333333333333333333333333333333333333333333333333333333333",
        environment: "production",
        targetHost: "srv1749248",
        sequence: 42,
      },
    });

    const res = await request(createApp())
      .get(`/api/release-candidates/approved-lease?authorizationId=${authorizationId}`)
      .set("X-Paperclip-Deploy-Token", "pcdeploy_test-token");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      authorizationId,
      approvalInteractionId,
      stagedArtifactPath: "/api/assets/77777777-7777-4777-8777-777777777777/content",
      stagedArtifactSha256,
      stagedSignatureBundlePath: "/api/assets/88888888-8888-4888-8888-888888888888/content",
      stagedSignatureBundleSha256: "3333333333333333333333333333333333333333333333333333333333333333",
      tarballSha256: stagedArtifactSha256,
      deployRecordReceiptPath: "/api/release-candidates/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/deploy-record-receipt",
      lease: {
        leaseId: authorizationId,
        releaseCandidateId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        targetHost: "srv1749248",
        deployRecordReceiptPath: "/api/release-candidates/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/deploy-record-receipt",
        tokenScope: "scanner:deploy:production:srv1749248:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
      candidate: {
        candidateId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        stagedArtifactPath: "/api/assets/77777777-7777-4777-8777-777777777777/content",
        stagedSignatureBundlePath: "/api/assets/88888888-8888-4888-8888-888888888888/content",
        stagedSignatureBundleSha256: "3333333333333333333333333333333333333333333333333333333333333333",
      },
    });
    expect(res.body).not.toHaveProperty("token");
    expect(mockReleaseCandidateService.getApprovedLease).toHaveBeenCalledWith(authorizationId, "pcdeploy_test-token");
  });

  it("rejects approved lease callers that omit the deploy token header", async () => {
    const authorizationId = "99999999-9999-4999-8999-999999999999";

    const res = await request(createApp())
      .get(`/api/release-candidates/approved-lease?authorizationId=${authorizationId}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Missing deploy authorization token header");
    expect(mockReleaseCandidateService.getApprovedLease).not.toHaveBeenCalled();
  });

  it("rejects deprecated query-string deploy tokens before service access", async () => {
    const authorizationId = "99999999-9999-4999-8999-999999999999";

    const res = await request(createApp())
      .get(`/api/release-candidates/approved-lease?authorizationId=${authorizationId}&token=pcdeploy_query-token`)
      .set("X-Paperclip-Deploy-Token", "pcdeploy_header-token");

    expect(res.status).toBe(400);
    expect(mockReleaseCandidateService.getApprovedLease).not.toHaveBeenCalled();
  });

  it("passes deploy-record tokens only from the header and keeps the request target token-free", async () => {
    const authorizationId = "99999999-9999-4999-8999-999999999999";
    const requestTargets: string[] = [];
    mockReleaseCandidateService.recordDeployEvent.mockResolvedValue({
      eventType: "deploy_started",
      authorization: { id: authorizationId },
      candidate: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        companyId,
        sourceIssueId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      },
    });
    const app = createApp((req, _res, next) => {
      requestTargets.push(req.originalUrl);
      next();
    });

    const res = await request(app)
      .post("/api/release-candidates/deploy-records")
      .set("X-Paperclip-Deploy-Token", "pcdeploy_header-token")
      .send({ authorizationId, status: "started", commitSha: "abc1234567" });

    expect(res.status).toBe(201);
    expect(mockReleaseCandidateService.recordDeployEvent).toHaveBeenCalledWith(
      expect.objectContaining({ authorizationId, status: "started", token: "pcdeploy_header-token" }),
      expect.any(Object),
    );
    expect(requestTargets).toEqual(["/api/release-candidates/deploy-records"]);
    expect(JSON.stringify(requestTargets)).not.toContain("pcdeploy_header-token");
  });

  it("rejects deprecated body deploy tokens for deploy records", async () => {
    const authorizationId = "99999999-9999-4999-8999-999999999999";

    const res = await request(createApp())
      .post("/api/release-candidates/deploy-records")
      .set("X-Paperclip-Deploy-Token", "pcdeploy_header-token")
      .send({ authorizationId, token: "pcdeploy_body-token", status: "started" });

    expect(res.status).toBe(400);
    expect(mockReleaseCandidateService.recordDeployEvent).not.toHaveBeenCalled();
  });

  it("passes stage-relay artifact tokens only from the header", async () => {
    const authorizationId = "99999999-9999-4999-8999-999999999999";
    const tarball = Buffer.from("scanner relay artifact");
    const signatureBundle = Buffer.from("{\"mediaType\":\"application/vnd.dev.sigstore.bundle+json\"}");
    const tarballSha256 = `sha256:${createHash("sha256").update(tarball).digest("hex")}`;
    const signatureBundleSha256 = `sha256:${createHash("sha256").update(signatureBundle).digest("hex")}`;
    mockReleaseCandidateService.verifyRelayAuthorization.mockResolvedValue({
      authorization: { id: authorizationId },
      candidate: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        companyId,
        sourceIssueId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      },
    });
    mockAssetService.create
      .mockResolvedValueOnce({ id: "77777777-7777-4777-8777-777777777777" })
      .mockResolvedValueOnce({ id: "88888888-8888-4888-8888-888888888888" });
    mockReleaseCandidateService.stageRelayArtifact.mockResolvedValue({
      id: authorizationId,
      candidateId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      leaseArtifactAssetId: "77777777-7777-4777-8777-777777777777",
      targetHost: "srv1749248",
      imageDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      environment: "production",
      sequence: 42,
      leaseIssuedAt: new Date("2026-07-14T14:00:00.000Z"),
    });
    const storage = {
      putFile: vi.fn()
        .mockResolvedValueOnce({
        provider: "local_disk",
        objectKey: "release-candidates/artifact.tar",
        contentType: "application/x-tar",
        byteSize: tarball.length,
        sha256: tarballSha256.replace(/^sha256:/, ""),
        originalFilename: "scanner-release-candidate.tar",
        })
        .mockResolvedValueOnce({
          provider: "local_disk",
          objectKey: "release-candidates/signature.sigstore.json",
          contentType: "application/vnd.dev.sigstore.bundle+json",
          byteSize: signatureBundle.length,
          sha256: signatureBundleSha256.replace(/^sha256:/, ""),
          originalFilename: "scanner-edge-image.sigstore.json",
        }),
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        source: "agent_jwt",
        agentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        companyId,
        runId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      };
      next();
    });
    app.use("/api", releaseCandidateRoutes({} as never, storage as never));
    app.use(errorHandler);

    const res = await request(app)
      .post(`/api/release-deploy-authorizations/${authorizationId}/stage-relay-artifact`)
      .set("X-Paperclip-Deploy-Token", "pcdeploy_header-token")
      .send({
        imageDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        sbomHash: "2222222222222222222222222222222222222222222222222222222222222222",
        signatureVerified: true,
        sbomVerified: true,
        tarballSha256,
        tarballBase64: tarball.toString("base64"),
        signatureBundleSha256,
        signatureBundleBase64: signatureBundle.toString("base64"),
      });

    expect(res.status).toBe(201);
    expect(mockReleaseCandidateService.verifyRelayAuthorization).toHaveBeenCalledWith(
      authorizationId,
      "pcdeploy_header-token",
      expect.objectContaining({
        tarballSha256: tarballSha256.replace(/^sha256:/, ""),
        signatureBundleSha256: signatureBundleSha256.replace(/^sha256:/, ""),
      }),
    );
    expect(mockReleaseCandidateService.stageRelayArtifact).toHaveBeenCalledWith(
      authorizationId,
      "pcdeploy_header-token",
      expect.any(Object),
      "77777777-7777-4777-8777-777777777777",
      "88888888-8888-4888-8888-888888888888",
      expect.any(Object),
    );
  });

  it("posts idempotent deploy receipts without the one-time deploy token", async () => {
    const candidateId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const authorizationId = "99999999-9999-4999-8999-999999999999";
    mockReleaseCandidateService.recordDeployReceipt.mockResolvedValue({
      alreadyRecorded: true,
      eventType: "deploy_receipt_duplicate",
      authorization: { id: authorizationId },
      candidate: {
        id: candidateId,
        companyId,
        sourceIssueId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      },
    });

    const res = await request(createApp())
      .post(`/api/release-candidates/${candidateId}/deploy-record-receipt`)
      .send({
        schema_version: 1,
        receipt_path: `/api/release-candidates/${candidateId}/deploy-record-receipt`,
        lease_id: authorizationId,
        candidate_id: candidateId,
        record: {
          lease_id: authorizationId,
          candidate_id: candidateId,
          status: "activated",
        },
      });

    expect(res.status).toBe(200);
    expect(mockReleaseCandidateService.recordDeployReceipt).toHaveBeenCalledWith(
      candidateId,
      expect.objectContaining({
        leaseId: authorizationId,
        candidateId,
        receiptPath: `/api/release-candidates/${candidateId}/deploy-record-receipt`,
      }),
      expect.any(Object),
    );
  });
});
