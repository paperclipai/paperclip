import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { releaseCandidateRoutes } from "../routes/release-candidates.js";

const mockAssetService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
}));

const mockReleaseCandidateService = vi.hoisted(() => ({
  getApprovedLease: vi.fn(),
  recordDeployEvent: vi.fn(),
  verifyRelayAuthorization: vi.fn(),
  stageRelayArtifact: vi.fn(),
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
    mockAssetService.create.mockReset();
    mockAssetService.getById.mockReset();
  });

  it("returns staged artifact digest fields and approval interaction id for approved leases", async () => {
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
        leaseSignatureBundleAssetId: "88888888-8888-4888-8888-888888888888",
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
        stagedSignatureBundleSha256: "3333333333333333333333333333333333333333333333333333333333333333",
      },
    });

    const res = await request(createApp())
      .get(`/api/release-candidates/approved-lease?authorizationId=${authorizationId}`)
      .set("X-Paperclip-Deploy-Token", "pcdeploy_test-token");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      authorizationId,
      approvalInteractionId,
      stagedArtifactPath: `/api/release-deploy-authorizations/${authorizationId}/staged-artifact`,
      stagedArtifactSha256,
      stagedSignatureBundlePath: `/api/release-deploy-authorizations/${authorizationId}/staged-signature-bundle`,
      stagedSignatureBundleSha256: "3333333333333333333333333333333333333333333333333333333333333333",
      tarballSha256: stagedArtifactSha256,
    });
    expect(res.body).not.toHaveProperty("token");
    expect(res.body).not.toHaveProperty("signatureBundleRef");
    expect(JSON.stringify(res.body)).not.toContain("oci://registry.example/scanner/signature");
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
      leaseSignatureBundleAssetId: "88888888-8888-4888-8888-888888888888",
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
          originalFilename: "scanner-release-candidate.sigstore.json",
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
      expect.objectContaining({ tarballSha256: tarballSha256.replace(/^sha256:/, "") }),
    );
    expect(mockReleaseCandidateService.stageRelayArtifact).toHaveBeenCalledWith(
      authorizationId,
      "pcdeploy_header-token",
      expect.any(Object),
      {
        artifactAssetId: "77777777-7777-4777-8777-777777777777",
        signatureBundleAssetId: "88888888-8888-4888-8888-888888888888",
      },
      expect.any(Object),
    );
    expect(res.body.lease).toMatchObject({
      artifactPath: `/api/release-deploy-authorizations/${authorizationId}/staged-artifact`,
      signatureBundlePath: `/api/release-deploy-authorizations/${authorizationId}/staged-signature-bundle`,
    });
  });

  it("rejects relay artifact staging when the signature bundle bytes do not match the declared hash", async () => {
    const authorizationId = "99999999-9999-4999-8999-999999999999";
    const tarball = Buffer.from("scanner relay artifact");

    const res = await request(createApp())
      .post(`/api/release-deploy-authorizations/${authorizationId}/stage-relay-artifact`)
      .set("X-Paperclip-Deploy-Token", "pcdeploy_header-token")
      .send({
        imageDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        sbomHash: "2222222222222222222222222222222222222222222222222222222222222222",
        signatureVerified: true,
        sbomVerified: true,
        tarballSha256: createHash("sha256").update(tarball).digest("hex"),
        tarballBase64: tarball.toString("base64"),
        signatureBundleSha256: "3333333333333333333333333333333333333333333333333333333333333333",
        signatureBundleBase64: Buffer.from("wrong bundle").toString("base64"),
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("signatureBundleBase64 does not match signatureBundleSha256");
    expect(mockReleaseCandidateService.verifyRelayAuthorization).not.toHaveBeenCalled();
  });

  it("serves staged signature bundles only through the deploy token route", async () => {
    const authorizationId = "99999999-9999-4999-8999-999999999999";
    const bundle = Buffer.from("{\"bundle\":\"ok\"}");
    mockReleaseCandidateService.getApprovedLease.mockResolvedValue({
      authorization: {
        id: authorizationId,
        candidateId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        leaseSignatureBundleAssetId: "88888888-8888-4888-8888-888888888888",
      },
      candidate: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        companyId,
        sourceIssueId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      },
    });
    mockAssetService.getById.mockResolvedValue({
      id: "88888888-8888-4888-8888-888888888888",
      companyId,
      objectKey: "release-candidates/signature.sigstore.json",
      contentType: "application/vnd.dev.sigstore.bundle+json",
      byteSize: bundle.length,
      originalFilename: "scanner-release-candidate.sigstore.json",
    });
    const storage = {
      getObject: vi.fn().mockResolvedValue({
        stream: Readable.from(bundle),
        contentType: "application/vnd.dev.sigstore.bundle+json",
        contentLength: bundle.length,
      }),
    };
    const requestTargets: string[] = [];
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      requestTargets.push(req.originalUrl);
      next();
    });
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
      .get(`/api/release-deploy-authorizations/${authorizationId}/staged-signature-bundle`)
      .set("X-Paperclip-Deploy-Token", "pcdeploy_header-token");

    expect(res.status).toBe(200);
    expect(res.text).toBe(bundle.toString("utf8"));
    expect(requestTargets).toEqual([`/api/release-deploy-authorizations/${authorizationId}/staged-signature-bundle`]);
    expect(JSON.stringify(requestTargets)).not.toContain("pcdeploy_header-token");
    expect(mockReleaseCandidateService.getApprovedLease).toHaveBeenCalledWith(authorizationId, "pcdeploy_header-token");
    expect(storage.getObject).toHaveBeenCalledWith(companyId, "release-candidates/signature.sigstore.json");
  });

  it("rejects staged signature bundle downloads before service access when the header is missing", async () => {
    const authorizationId = "99999999-9999-4999-8999-999999999999";

    const res = await request(createApp())
      .get(`/api/release-deploy-authorizations/${authorizationId}/staged-signature-bundle`);

    expect(res.status).toBe(401);
    expect(mockReleaseCandidateService.getApprovedLease).not.toHaveBeenCalled();
  });

  it("rejects staged signature bundle downloads when the bundle has not been staged", async () => {
    const authorizationId = "99999999-9999-4999-8999-999999999999";
    mockReleaseCandidateService.getApprovedLease.mockResolvedValue({
      authorization: {
        id: authorizationId,
        candidateId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        leaseSignatureBundleAssetId: null,
      },
      candidate: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        companyId,
        sourceIssueId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      },
    });

    const res = await request(createApp())
      .get(`/api/release-deploy-authorizations/${authorizationId}/staged-signature-bundle`)
      .set("X-Paperclip-Deploy-Token", "pcdeploy_header-token");

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Release candidate signature bundle has not been staged");
  });
});
