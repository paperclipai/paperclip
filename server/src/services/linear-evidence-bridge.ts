import { createHash } from "node:crypto";
import type { IssueLinearEvidencePolicy } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

export const LINEAR_EVIDENCE_CONTRACT_VERSION = 1 as const;

export interface LinearEvidenceArtifact {
  pullRequestUrl?: string | null;
  sha256?: string | null;
}

export interface LinearEvidenceVerification {
  verifierId: string;
  independent: boolean;
  result: "passed" | "failed";
  summary: string;
  testedAt: string;
}

export interface LinearEvidencePayload {
  contractVersion: typeof LINEAR_EVIDENCE_CONTRACT_VERSION;
  mappingKey: string;
  paperclipIssueId: string;
  paperclipIssueUpdatedAt: string;
  linearIssueId: string;
  implementerId: string;
  whatChanged: string;
  artifact: LinearEvidenceArtifact;
  verification: LinearEvidenceVerification;
  recordedAt: string;
}

export interface LinearEvidenceConflict {
  key: string;
  paperclipValue: unknown;
  linearValue: unknown;
  detectedAt: string;
  resolution: "unresolved" | "resolved";
}

export interface LinearEvidenceDeliveryReceipt {
  state: "pending" | "published" | "conflict";
  idempotencyKey: string;
  commentBodySha256: string | null;
  remoteCommentId: string | null;
  publishedAt: string | null;
}

/**
 * Connector-owned snapshot. Core Paperclip deliberately does not own Linear
 * credentials, mappings, cursors, or remote comment state.
 */
export interface LinearEvidenceCompletionSnapshot {
  mappingKey: string;
  linearIssueId: string;
  evidence: LinearEvidencePayload;
  evidenceSha256: string;
  idempotencyKey: string;
  delivery: LinearEvidenceDeliveryReceipt;
  conflicts: LinearEvidenceConflict[];
}

export interface LinearEvidenceBridgeReader {
  getCompletionSnapshot(input: {
    companyId: string;
    paperclipIssueId: string;
    paperclipIssueUpdatedAt: string | null;
    mappingKey: string;
  }): Promise<LinearEvidenceCompletionSnapshot | null>;
}

export interface LinearEvidenceGateIssue {
  id: string;
  companyId: string;
  identifier?: string | null;
  title?: string | null;
  updatedAt?: Date | string | null;
}

export type LinearEvidenceGateFailureCode =
  | "bridge_unavailable"
  | "evidence_missing"
  | "mapping_mismatch"
  | "evidence_invalid"
  | "evidence_not_published"
  | "independent_qa_missing"
  | "evidence_conflict";

export type LinearEvidenceGateResult =
  | { ok: true; snapshot: LinearEvidenceCompletionSnapshot }
  | {
      ok: false;
      code: LinearEvidenceGateFailureCode;
      reasons: string[];
      unresolvedConflictKeys?: string[];
    };

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validIsoDate(value: unknown) {
  return nonEmpty(value) && !Number.isNaN(Date.parse(value));
}

function validSha256(value: unknown) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function validPullRequestUrl(value: unknown) {
  if (!nonEmpty(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && /\/(pull|merge_requests)\/\d+(?:\/|$)/.test(url.pathname);
  } catch {
    return false;
  }
}

export function linearEvidenceMappingKey(companyId: string, paperclipIssueId: string) {
  return `paperclip-linear:v${LINEAR_EVIDENCE_CONTRACT_VERSION}:${companyId}:${paperclipIssueId}`;
}

export function linearEvidencePayloadSha256(evidence: LinearEvidencePayload) {
  return sha256(stableStringify(evidence));
}

export function linearEvidenceIdempotencyKey(evidence: LinearEvidencePayload) {
  return `paperclip-evidence:v${LINEAR_EVIDENCE_CONTRACT_VERSION}:${evidence.mappingKey}:${linearEvidencePayloadSha256(evidence)}`;
}

export function buildLinearEvidenceComment(evidence: LinearEvidencePayload) {
  const idempotencyKey = linearEvidenceIdempotencyKey(evidence);
  const artifactLines = [
    evidence.artifact.pullRequestUrl ? `- Pull request: ${evidence.artifact.pullRequestUrl}` : null,
    evidence.artifact.sha256 ? `- Artifact SHA-256: \`${evidence.artifact.sha256}\`` : null,
  ].filter((line): line is string => Boolean(line));
  return [
    "## Paperclip completion evidence",
    "",
    `- Paperclip issue: \`${evidence.paperclipIssueId}\``,
    `- Paperclip issue version: ${evidence.paperclipIssueUpdatedAt}`,
    `- Mapping key: \`${evidence.mappingKey}\``,
    `- Evidence timestamp: ${evidence.recordedAt}`,
    `- Implementer: \`${evidence.implementerId}\``,
    "",
    "### What changed",
    "",
    evidence.whatChanged.trim(),
    "",
    "### Artifact",
    "",
    ...artifactLines,
    "",
    "### Independent verification",
    "",
    `- Verifier: \`${evidence.verification.verifierId}\``,
    `- Independent: ${evidence.verification.independent ? "yes" : "no"}`,
    `- Result: **${evidence.verification.result.toUpperCase()}**`,
    `- Tested at: ${evidence.verification.testedAt}`,
    `- Summary: ${evidence.verification.summary.trim()}`,
    "",
    `<!-- paperclip-evidence:${idempotencyKey} -->`,
  ].join("\n");
}

export function linearEvidenceCommentSha256(evidence: LinearEvidencePayload) {
  return sha256(buildLinearEvidenceComment(evidence));
}

export function evaluateLinearEvidenceCompletion(input: {
  issue: LinearEvidenceGateIssue;
  policy: IssueLinearEvidencePolicy;
  snapshot: LinearEvidenceCompletionSnapshot | null;
}): LinearEvidenceGateResult {
  const expectedMappingKey = linearEvidenceMappingKey(input.issue.companyId, input.issue.id);
  const snapshot = input.snapshot;
  if (!snapshot) {
    return { ok: false, code: "evidence_missing", reasons: ["No connector-owned Linear evidence snapshot exists"] };
  }

  const mappingReasons: string[] = [];
  if (snapshot.mappingKey !== expectedMappingKey) mappingReasons.push("Snapshot mapping key does not match this issue");
  if (!nonEmpty(snapshot.linearIssueId)) mappingReasons.push("Linear issue id is missing");
  if (snapshot.evidence.mappingKey !== expectedMappingKey) mappingReasons.push("Evidence mapping key does not match this issue");
  if (snapshot.evidence.paperclipIssueId !== input.issue.id) mappingReasons.push("Evidence references a different Paperclip issue");
  const issueUpdatedAt = input.issue.updatedAt instanceof Date
    ? input.issue.updatedAt.toISOString()
    : input.issue.updatedAt ?? null;
  if (!issueUpdatedAt || snapshot.evidence.paperclipIssueUpdatedAt !== issueUpdatedAt) {
    mappingReasons.push("Evidence references a stale Paperclip issue version");
  }
  if (snapshot.evidence.linearIssueId !== snapshot.linearIssueId) mappingReasons.push("Evidence references a different Linear issue");
  if (mappingReasons.length > 0) return { ok: false, code: "mapping_mismatch", reasons: mappingReasons };

  const invalidReasons: string[] = [];
  if (snapshot.evidence.contractVersion !== LINEAR_EVIDENCE_CONTRACT_VERSION) invalidReasons.push("Unsupported evidence contract version");
  if (!nonEmpty(snapshot.evidence.implementerId)) invalidReasons.push("Implementer identity is missing");
  if (!nonEmpty(snapshot.evidence.whatChanged)) invalidReasons.push("What-changed evidence is missing");
  if (!validIsoDate(snapshot.evidence.recordedAt)) invalidReasons.push("Evidence timestamp is invalid");
  if (!validIsoDate(snapshot.evidence.verification.testedAt)) invalidReasons.push("Verification timestamp is invalid");
  if (!nonEmpty(snapshot.evidence.verification.verifierId)) invalidReasons.push("Verifier identity is missing");
  if (!nonEmpty(snapshot.evidence.verification.summary)) invalidReasons.push("Verification summary is missing");
  if (!validSha256(snapshot.evidence.artifact.sha256) && !validPullRequestUrl(snapshot.evidence.artifact.pullRequestUrl)) {
    invalidReasons.push("A valid artifact SHA-256 or pull request URL is required");
  }
  const expectedEvidenceSha = linearEvidencePayloadSha256(snapshot.evidence);
  const expectedIdempotencyKey = linearEvidenceIdempotencyKey(snapshot.evidence);
  if (snapshot.evidenceSha256 !== expectedEvidenceSha) invalidReasons.push("Evidence digest does not match the canonical payload");
  if (snapshot.idempotencyKey !== expectedIdempotencyKey) invalidReasons.push("Evidence idempotency key does not match the canonical payload");
  if (invalidReasons.length > 0) return { ok: false, code: "evidence_invalid", reasons: invalidReasons };

  const unresolvedConflictKeys = snapshot.conflicts
    .filter((conflict) => conflict.resolution === "unresolved")
    .map((conflict) => conflict.key);
  if (snapshot.delivery.state === "conflict" || unresolvedConflictKeys.length > 0) {
    return {
      ok: false,
      code: "evidence_conflict",
      reasons: ["Paperclip and Linear evidence contain an unresolved conflict"],
      unresolvedConflictKeys,
    };
  }

  const expectedCommentSha = linearEvidenceCommentSha256(snapshot.evidence);
  if (
    snapshot.delivery.state !== "published" ||
    snapshot.delivery.idempotencyKey !== expectedIdempotencyKey ||
    snapshot.delivery.commentBodySha256 !== expectedCommentSha ||
    !nonEmpty(snapshot.delivery.remoteCommentId) ||
    !validIsoDate(snapshot.delivery.publishedAt)
  ) {
    return {
      ok: false,
      code: "evidence_not_published",
      reasons: ["The required evidence comment has no valid Linear publication receipt"],
    };
  }

  if (
    snapshot.evidence.verification.result !== "passed" ||
    (input.policy.independentQaRequired && (
      !snapshot.evidence.verification.independent ||
      snapshot.evidence.verification.verifierId === snapshot.evidence.implementerId
    ))
  ) {
    return {
      ok: false,
      code: "independent_qa_missing",
      reasons: ["Independent QA must pass before the issue can be completed"],
    };
  }

  return { ok: true, snapshot };
}

export async function assertLinearEvidenceCompletion(input: {
  issue: LinearEvidenceGateIssue;
  policy: IssueLinearEvidencePolicy;
  bridge?: LinearEvidenceBridgeReader;
}) {
  const mappingKey = linearEvidenceMappingKey(input.issue.companyId, input.issue.id);
  const paperclipIssueUpdatedAt = input.issue.updatedAt instanceof Date
    ? input.issue.updatedAt.toISOString()
    : input.issue.updatedAt ?? null;
  if (!input.bridge) {
    throw unprocessable("Linear completion evidence is required but the bridge is unavailable", {
      code: "linear_evidence_gate_failed",
      reason: "bridge_unavailable" satisfies LinearEvidenceGateFailureCode,
      mappingKey,
    });
  }
  const snapshot = await input.bridge.getCompletionSnapshot({
    companyId: input.issue.companyId,
    paperclipIssueId: input.issue.id,
    paperclipIssueUpdatedAt,
    mappingKey,
  });
  const result = evaluateLinearEvidenceCompletion({ issue: input.issue, policy: input.policy, snapshot });
  if (!result.ok) {
    throw unprocessable("Linear completion evidence gate is not satisfied", {
      code: "linear_evidence_gate_failed",
      reason: result.code,
      reasons: result.reasons,
      mappingKey,
      ...(result.unresolvedConflictKeys ? { unresolvedConflictKeys: result.unresolvedConflictKeys } : {}),
    });
  }
  return result.snapshot;
}
