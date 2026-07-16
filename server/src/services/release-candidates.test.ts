import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { releaseDeployAuthorizations } from "@paperclipai/db";
import { HttpError } from "../errors.js";
import { releaseCandidateService, verifyRelayArtifact } from "./release-candidates.js";

const candidate = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  companyId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  sourceIssueId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  createdByAgentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  createdByRunId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  commitSha: "abc1234567890",
  imageDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  signatureBundleRef: "oci://registry.example/scanner/signature",
  signatureBundleSha256: "3333333333333333333333333333333333333333333333333333333333333333",
  provenanceRef: "https://github.example/workflows/1/provenance",
  sbomHash: "2222222222222222222222222222222222222222222222222222222222222222",
  workflowRunUrl: "https://github.example/workflows/1",
  environment: "production",
  targetHost: "srv1749248",
  sequence: 42,
  documentRevisionId: "doc-rev-1",
  status: "candidate_created",
  approvalInteractionId: null,
  approvedByUserId: null,
  approvedAt: null,
  stagedArtifactAssetId: null,
  stagedArtifactSha256: null,
  stagedSignatureBundleAssetId: null,
  stagedSignatureBundleSha256: null,
  stagedAt: null,
  metadata: {},
  createdAt: new Date("2026-07-13T00:00:00.000Z"),
  updatedAt: new Date("2026-07-13T00:00:00.000Z"),
};

function makeDb(
  selectRows: unknown[][] = [],
  options: { atomicAuthorizationConsume?: boolean; atomicAuthorizationIssue?: boolean } = {},
) {
  const inserted: unknown[] = [];
  const updated: unknown[] = [];
  let authorizationConsumed = false;
  let issuedAuthorization: Record<string, unknown> | null = null;
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          then: (resolve: (rows: unknown[]) => unknown) => {
            const queuedRows = selectRows.shift();
            if (queuedRows) return resolve(queuedRows);
            if (options.atomicAuthorizationIssue && table === releaseDeployAuthorizations && issuedAuthorization) {
              return resolve([issuedAuthorization]);
            }
            return resolve([]);
          },
        }),
      }),
    }),
    insert: () => ({
      values: (value: unknown) => {
        inserted.push(value);
        const builder = {
          onConflictDoNothing: () => builder,
          returning: async () => {
            if (options.atomicAuthorizationIssue && "tokenHash" in (value as Record<string, unknown>)) {
              if (issuedAuthorization) return [];
              issuedAuthorization = {
                id: "99999999-9999-4999-8999-999999999999",
                ...(value as Record<string, unknown>),
              };
              return [issuedAuthorization];
            }
            return [value];
          },
        };
        return builder;
      },
    }),
    update: () => ({
      set: (value: unknown) => {
        updated.push(value);
        return {
          where: () => ({
            returning: async () => {
              if (options.atomicAuthorizationConsume && "leaseIssuedAt" in (value as Record<string, unknown>)) {
                if (authorizationConsumed) return [];
                authorizationConsumed = true;
              }
              return [{ ...candidate, ...(value as Record<string, unknown>) }];
            },
          }),
        };
      },
    }),
  };
  return { db: db as never, inserted, updated };
}

describe("release candidate approval relay", () => {
  it("builds Founder confirmation target bound to candidate id and image digest", () => {
    const { db } = makeDb();
    const input = releaseCandidateService(db).buildApprovalInteractionInput(candidate);
    expect(input.kind).toBe("request_confirmation");
    expect(input.payload.target).toMatchObject({
      type: "custom",
      key: `release_candidate:${candidate.id}`,
      revisionId: candidate.imageDigest,
    });
    expect(input.payload.detailsMarkdown).toContain(candidate.sbomHash);
    expect(input.payload.detailsMarkdown).toContain(candidate.signatureBundleSha256);
  });

  it("blocks candidate mutation after approval interaction creation", async () => {
    const immutableCandidate = {
      ...candidate,
      status: "approval_requested",
      approvalInteractionId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    };
    const { db } = makeDb([[immutableCandidate]]);
    await expect(
      releaseCandidateService(db).updateMutable(candidate.id, { workflowRunUrl: "https://github.example/new" }, {}),
    ).rejects.toMatchObject({
      status: 409,
      message: "Release candidate is immutable after approval interaction creation",
    });
  });

  it("rejects accepted confirmations whose target digest does not match the candidate", async () => {
    const { db } = makeDb([[{
      ...candidate,
      status: "approval_requested",
      approvalInteractionId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    }]]);

    await expect(
      releaseCandidateService(db).handleAcceptedInteraction(candidate.sourceIssueId, {
        id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        companyId: candidate.companyId,
        issueId: candidate.sourceIssueId,
        kind: "request_confirmation",
        status: "accepted",
        continuationPolicy: "wake_assignee",
        idempotencyKey: null,
        sourceCommentId: null,
        sourceRunId: null,
        title: null,
        summary: null,
        payload: {
          version: 1,
          prompt: "approve",
          target: {
            type: "custom",
            key: `release_candidate:${candidate.id}`,
            revisionId: "sha256:9999999999999999999999999999999999999999999999999999999999999999",
          },
        },
        result: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, { userId: "founder" }),
    ).rejects.toMatchObject({
      status: 422,
      message: "Release candidate approval digest does not match candidate record",
    });
  });

  it("issues a token scoped to target host, digest, environment, sequence and stores only its hash", async () => {
    const approvedCandidate = {
      ...candidate,
      status: "approval_requested",
      approvalInteractionId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    };
    const { db, inserted } = makeDb([[approvedCandidate], []]);
    const result = await releaseCandidateService(db).handleAcceptedInteraction(candidate.sourceIssueId, {
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      companyId: candidate.companyId,
      issueId: candidate.sourceIssueId,
      kind: "request_confirmation",
      status: "accepted",
      continuationPolicy: "wake_assignee",
      idempotencyKey: null,
      sourceCommentId: null,
      sourceRunId: null,
      title: null,
      summary: null,
      payload: {
        version: 1,
        prompt: "approve",
        target: {
          type: "custom",
          key: `release_candidate:${candidate.id}`,
          revisionId: candidate.imageDigest,
        },
      },
      result: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }, { userId: "founder" });

    expect(result?.token).toMatch(/^pcdeploy_/);
    expect(result?.authorization).toMatchObject({
      targetHost: candidate.targetHost,
      imageDigest: candidate.imageDigest,
      environment: candidate.environment,
      sequence: candidate.sequence,
    });
    const authInsert = inserted.find((value) =>
      typeof value === "object"
      && value !== null
      && "tokenHash" in value
    ) as Record<string, unknown>;
    expect(authInsert.tokenHash).toEqual(expect.any(String));
    expect(authInsert).not.toHaveProperty("token");
    expect(authInsert).not.toHaveProperty("secret");
  });

  it("issues exactly one plaintext token when the same approval is accepted concurrently", async () => {
    const approvedCandidate = {
      ...candidate,
      status: "approval_requested",
      approvalInteractionId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    };
    const interaction = {
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      companyId: candidate.companyId,
      issueId: candidate.sourceIssueId,
      kind: "request_confirmation" as const,
      status: "accepted" as const,
      continuationPolicy: "wake_assignee" as const,
      idempotencyKey: null,
      sourceCommentId: null,
      sourceRunId: null,
      title: null,
      summary: null,
      payload: {
        version: 1 as const,
        prompt: "approve",
        target: {
          type: "custom" as const,
          key: `release_candidate:${candidate.id}`,
          revisionId: candidate.imageDigest,
        },
      },
      result: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const { db } = makeDb(
      [[approvedCandidate], [approvedCandidate], [], []],
      { atomicAuthorizationIssue: true },
    );
    const service = releaseCandidateService(db);

    const results = await Promise.all([
      service.handleAcceptedInteraction(candidate.sourceIssueId, interaction, { userId: "founder" }),
      service.handleAcceptedInteraction(candidate.sourceIssueId, interaction, { userId: "founder" }),
    ]);

    expect(results.filter((result) => result?.token?.startsWith("pcdeploy_"))).toHaveLength(1);
    expect(results.filter((result) => result?.token === null)).toHaveLength(1);
    expect(results.map((result) => result?.alreadyIssued).sort()).toEqual([false, true]);
    expect(results[0]?.authorization.id).toBe(results[1]?.authorization.id);
  });

  it("resolves approved leases and records deploy audit events through the token scope", async () => {
    const authorization = {
      id: "99999999-9999-4999-8999-999999999999",
      companyId: candidate.companyId,
      candidateId: candidate.id,
      approvalInteractionId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      tokenHash: "ignored-in-test",
      tokenPrefix: "pcdeploy_sample",
      targetHost: candidate.targetHost,
      imageDigest: candidate.imageDigest,
      environment: candidate.environment,
      sequence: candidate.sequence,
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
      leaseArtifactAssetId: null,
      leaseSignatureBundleAssetId: null,
      leaseIssuedAt: null,
      createdByUserId: "founder",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const { db, inserted } = makeDb([[authorization], [candidate], [authorization], [candidate]]);
    const service = releaseCandidateService(db);
    const token = "pcdeploy_test-token";
    authorization.tokenHash = createHash("sha256").update(token).digest("hex");

    await expect(service.getApprovedLease(authorization.id, token)).resolves.toMatchObject({
      authorization: { id: authorization.id },
      candidate: { id: candidate.id },
    });

    await expect(service.recordDeployEvent({
      authorizationId: authorization.id,
      token,
      status: "succeeded",
      commitSha: candidate.commitSha,
      healthStatus: "ok",
    }, { agentId: candidate.createdByAgentId })).resolves.toMatchObject({
      eventType: "deploy_succeeded",
    });

    expect(inserted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "deploy_succeeded",
        redacted: true,
      }),
      expect.objectContaining({
        metadata: expect.objectContaining({
          sections: expect.arrayContaining([
            expect.objectContaining({ title: "Release Candidate Audit" }),
          ]),
        }),
      }),
    ]));
    expect(JSON.stringify(inserted)).not.toContain(token);
  });

  it("rejects wrong, expired, replayed, and wrong-scope relay authorization tokens", async () => {
    const token = "pcdeploy_test-token";
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const artifact = {
      imageDigest: candidate.imageDigest,
      sbomHash: candidate.sbomHash,
      signatureVerified: true,
      sbomVerified: true,
      tarballSha256: "4444444444444444444444444444444444444444444444444444444444444444",
      signatureBundleSha256: candidate.signatureBundleSha256,
    };
    const baseAuthorization = {
      id: "99999999-9999-4999-8999-999999999999",
      companyId: candidate.companyId,
      candidateId: candidate.id,
      approvalInteractionId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      tokenHash,
      tokenPrefix: "pcdeploy_sample",
      targetHost: candidate.targetHost,
      imageDigest: candidate.imageDigest,
      environment: candidate.environment,
      sequence: candidate.sequence,
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
      leaseArtifactAssetId: null,
      leaseSignatureBundleAssetId: null,
      leaseIssuedAt: null,
      createdByUserId: "founder",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await expect(
      releaseCandidateService(makeDb([[baseAuthorization], [candidate]]).db)
        .verifyRelayAuthorization(baseAuthorization.id, "pcdeploy_wrong-token", artifact),
    ).rejects.toMatchObject({ status: 401, message: "Deploy authorization token is invalid" });

    await expect(
      releaseCandidateService(makeDb([[{ ...baseAuthorization, expiresAt: new Date(Date.now() - 1_000) }], [candidate]]).db)
        .verifyRelayAuthorization(baseAuthorization.id, token, artifact),
    ).rejects.toMatchObject({ status: 401, message: "Deploy authorization token is expired" });

    await expect(
      releaseCandidateService(makeDb([[{ ...baseAuthorization, usedAt: new Date() }], [candidate]]).db)
        .verifyRelayAuthorization(baseAuthorization.id, token, artifact),
    ).rejects.toMatchObject({ status: 409, message: "Deploy authorization token has already been used" });

    await expect(
      releaseCandidateService(makeDb([[{ ...baseAuthorization, targetHost: "other-host" }], [candidate]]).db)
        .verifyRelayAuthorization(baseAuthorization.id, token, artifact),
    ).rejects.toMatchObject({ status: 409, message: "Deploy authorization scope no longer matches release candidate" });
  });

  it("allows exactly one concurrent relay artifact consumer", async () => {
    const token = "pcdeploy_parallel-token";
    const authorization = {
      id: "99999999-9999-4999-8999-999999999999",
      companyId: candidate.companyId,
      candidateId: candidate.id,
      approvalInteractionId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      tokenHash: createHash("sha256").update(token).digest("hex"),
      tokenPrefix: "pcdeploy_parallel",
      targetHost: candidate.targetHost,
      imageDigest: candidate.imageDigest,
      environment: candidate.environment,
      sequence: candidate.sequence,
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
      leaseArtifactAssetId: null,
      leaseSignatureBundleAssetId: null,
      leaseIssuedAt: null,
      createdByUserId: "founder",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const artifact = {
      imageDigest: candidate.imageDigest,
      sbomHash: candidate.sbomHash,
      signatureVerified: true,
      sbomVerified: true,
      tarballSha256: "4444444444444444444444444444444444444444444444444444444444444444",
      signatureBundleSha256: candidate.signatureBundleSha256,
      tarballBytes: Buffer.from("artifact"),
      signatureBundleBytes: Buffer.from("signature"),
    };
    const { db } = makeDb(
      [[authorization], [authorization], [candidate], [candidate]],
      { atomicAuthorizationConsume: true },
    );
    const service = releaseCandidateService(db);

    const results = await Promise.allSettled([
      service.stageRelayArtifact(authorization.id, token, artifact, {
        artifactAssetId: "asset-one",
        signatureBundleAssetId: "signature-one",
      }, { agentId: candidate.createdByAgentId }),
      service.stageRelayArtifact(authorization.id, token, artifact, {
        artifactAssetId: "asset-two",
        signatureBundleAssetId: "signature-two",
      }, { agentId: candidate.createdByAgentId }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: {
        status: 409,
        message: "Deploy authorization token has already been used",
      },
    });
  });

  it("refuses relay artifacts with wrong digest, wrong SBOM, or missing signature verification", () => {
    expect(() => verifyRelayArtifact(candidate, {
      imageDigest: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
      sbomHash: candidate.sbomHash,
      signatureVerified: true,
      sbomVerified: true,
      tarballSha256: "4444444444444444444444444444444444444444444444444444444444444444",
      signatureBundleSha256: candidate.signatureBundleSha256,
    })).toThrow(HttpError);

    expect(() => verifyRelayArtifact(candidate, {
      imageDigest: candidate.imageDigest,
      sbomHash: "5555555555555555555555555555555555555555555555555555555555555555",
      signatureVerified: true,
      sbomVerified: true,
      tarballSha256: "4444444444444444444444444444444444444444444444444444444444444444",
      signatureBundleSha256: candidate.signatureBundleSha256,
    })).toThrow("Relay artifact SBOM hash does not match approved candidate");

    expect(() => verifyRelayArtifact(candidate, {
      imageDigest: candidate.imageDigest,
      sbomHash: candidate.sbomHash,
      signatureVerified: false,
      sbomVerified: true,
      tarballSha256: "4444444444444444444444444444444444444444444444444444444444444444",
      signatureBundleSha256: candidate.signatureBundleSha256,
    })).toThrow("Relay artifact signature is not verified");

    expect(() => verifyRelayArtifact(candidate, {
      imageDigest: candidate.imageDigest,
      sbomHash: candidate.sbomHash,
      signatureVerified: true,
      sbomVerified: true,
      tarballSha256: "4444444444444444444444444444444444444444444444444444444444444444",
      signatureBundleSha256: "9999999999999999999999999999999999999999999999999999999999999999",
    })).toThrow("Relay artifact signature bundle hash does not match approved candidate");
  });
});
