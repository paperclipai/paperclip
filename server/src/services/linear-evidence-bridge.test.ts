import { describe, expect, it } from "vitest";
import {
  buildLinearEvidenceComment,
  evaluateLinearEvidenceCompletion,
  linearEvidenceCommentSha256,
  linearEvidenceIdempotencyKey,
  linearEvidenceMappingKey,
  linearEvidencePayloadSha256,
  type LinearEvidenceCompletionSnapshot,
  type LinearEvidencePayload,
} from "./linear-evidence-bridge.js";

const companyId = "00000000-0000-4000-8000-000000000001";
const issueId = "00000000-0000-4000-8000-000000000002";
const issueUpdatedAt = "2026-07-15T12:29:00.000Z";

function evidence(overrides: Partial<LinearEvidencePayload> = {}): LinearEvidencePayload {
  const mappingKey = linearEvidenceMappingKey(companyId, issueId);
  return {
    contractVersion: 1,
    mappingKey,
    paperclipIssueId: issueId,
    paperclipIssueUpdatedAt: issueUpdatedAt,
    linearIssueId: "linear-issue-381",
    implementerId: "codex-implementer-1",
    whatChanged: "Added the fail-closed completion evidence gate.",
    artifact: {
      pullRequestUrl: "https://github.com/acme/paperclip/pull/381",
      sha256: "a".repeat(64),
    },
    verification: {
      verifierId: "qa-agent-7",
      independent: true,
      result: "passed",
      summary: "Focused unit and service integration tests passed.",
      testedAt: "2026-07-15T12:30:00.000Z",
    },
    recordedAt: "2026-07-15T12:31:00.000Z",
    ...overrides,
  };
}

function snapshot(payload = evidence()): LinearEvidenceCompletionSnapshot {
  const idempotencyKey = linearEvidenceIdempotencyKey(payload);
  return {
    mappingKey: payload.mappingKey,
    linearIssueId: payload.linearIssueId,
    evidence: payload,
    evidenceSha256: linearEvidencePayloadSha256(payload),
    idempotencyKey,
    delivery: {
      state: "published",
      idempotencyKey,
      commentBodySha256: linearEvidenceCommentSha256(payload),
      remoteCommentId: "linear-comment-1",
      publishedAt: "2026-07-15T12:32:00.000Z",
    },
    conflicts: [],
  };
}

describe("Linear evidence bridge contract", () => {
  it("derives stable mapping and idempotency keys and embeds the retry marker", () => {
    const payload = evidence();
    expect(linearEvidenceMappingKey(companyId, issueId)).toBe(
      `paperclip-linear:v1:${companyId}:${issueId}`,
    );
    expect(linearEvidenceIdempotencyKey(payload)).toBe(linearEvidenceIdempotencyKey({
      ...payload,
      artifact: { sha256: payload.artifact.sha256, pullRequestUrl: payload.artifact.pullRequestUrl },
    }));
    expect(buildLinearEvidenceComment(payload)).toContain(
      `<!-- paperclip-evidence:${linearEvidenceIdempotencyKey(payload)} -->`,
    );
  });

  it("accepts a published canonical receipt with independent passing QA", () => {
    expect(evaluateLinearEvidenceCompletion({
      issue: { id: issueId, companyId, updatedAt: issueUpdatedAt },
      policy: { required: true, independentQaRequired: true },
      snapshot: snapshot(),
    })).toMatchObject({ ok: true });
  });

  it("fails closed when publication is absent or QA is not independent", () => {
    const unpublished = snapshot();
    unpublished.delivery = { ...unpublished.delivery, state: "pending", remoteCommentId: null };
    expect(evaluateLinearEvidenceCompletion({
      issue: { id: issueId, companyId, updatedAt: issueUpdatedAt },
      policy: { required: true, independentQaRequired: true },
      snapshot: unpublished,
    })).toMatchObject({ ok: false, code: "evidence_not_published" });

    const nonIndependentPayload = evidence({
      verification: {
        ...evidence().verification,
        independent: false,
      },
    });
    expect(evaluateLinearEvidenceCompletion({
      issue: { id: issueId, companyId, updatedAt: issueUpdatedAt },
      policy: { required: true, independentQaRequired: true },
      snapshot: snapshot(nonIndependentPayload),
    })).toMatchObject({ ok: false, code: "independent_qa_missing" });
  });

  it("rejects tampered receipts and preserves unresolved conflict keys", () => {
    const tampered = snapshot();
    tampered.evidence.whatChanged = "Different payload";
    expect(evaluateLinearEvidenceCompletion({
      issue: { id: issueId, companyId, updatedAt: issueUpdatedAt },
      policy: { required: true, independentQaRequired: true },
      snapshot: tampered,
    })).toMatchObject({ ok: false, code: "evidence_invalid" });

    expect(evaluateLinearEvidenceCompletion({
      issue: { id: issueId, companyId, updatedAt: "2026-07-15T12:40:00.000Z" },
      policy: { required: true, independentQaRequired: true },
      snapshot: snapshot(),
    })).toMatchObject({ ok: false, code: "mapping_mismatch" });

    const conflicted = snapshot();
    conflicted.conflicts = [{
      key: "status",
      paperclipValue: "done",
      linearValue: "in_progress",
      detectedAt: "2026-07-15T12:33:00.000Z",
      resolution: "unresolved",
    }];
    expect(evaluateLinearEvidenceCompletion({
      issue: { id: issueId, companyId, updatedAt: issueUpdatedAt },
      policy: { required: true, independentQaRequired: true },
      snapshot: conflicted,
    })).toMatchObject({
      ok: false,
      code: "evidence_conflict",
      unresolvedConflictKeys: ["status"],
    });
  });
});
