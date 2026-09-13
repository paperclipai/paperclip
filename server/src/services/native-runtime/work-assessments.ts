import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workAssessments } from "@paperclipai/db";
import type { NativeEvidenceAssessment } from "./evidence-classifier.js";
import { nativeSha256 } from "./canonical.js";

export async function recordNativeWorkAssessment(input: {
  db: Db;
  companyId: string;
  issueId: string;
  runId: string;
  turnId: string | null;
  contractId: string;
  contractCanonicalSha256: string;
  resultId: string;
  resultCanonicalSha256: string;
  priorIssueStatus: string;
  priorStatusVersion: number;
  priorDecisionId: string | null;
  policyVersion: string;
  assessment: NativeEvidenceAssessment;
  supersedesAssessmentId?: string | null;
}) {
  const assessmentJson = input.assessment as unknown as Record<string, unknown>;
  const inputDigest = nativeSha256({
    contractId: input.contractId,
    contractCanonicalSha256: input.contractCanonicalSha256,
    resultId: input.resultId,
    resultCanonicalSha256: input.resultCanonicalSha256,
    priorIssueStatus: input.priorIssueStatus,
    priorStatusVersion: input.priorStatusVersion,
    priorDecisionId: input.priorDecisionId,
    triggerKind: "native_result",
    triggerRef: input.resultId,
    triggerActorCompanyId: input.companyId,
    triggerCapability: "server_native_finalizer",
    policyVersion: input.policyVersion,
    assessment: assessmentJson,
  });
  const existing = await input.db.select().from(workAssessments).where(and(
    eq(workAssessments.issueId, input.issueId),
    eq(workAssessments.inputDigest, inputDigest),
  )).limit(1).then((rows) => rows[0] ?? null);
  if (existing) return existing;
  const [row] = await input.db.insert(workAssessments).values({
    companyId: input.companyId,
    issueId: input.issueId,
    runId: input.runId,
    turnId: input.turnId,
    contractId: input.contractId,
    resultId: input.resultId,
    triggerKind: "native_result",
    triggerRef: input.resultId,
    triggerCapability: "server_native_finalizer",
    triggerActorCompanyId: input.companyId,
    priorIssueStatus: input.priorIssueStatus,
    priorStatusVersion: input.priorStatusVersion,
    priorDecisionId: input.priorDecisionId,
    policyVersion: input.policyVersion,
    assessmentJson,
    inputDigest,
    supersedesAssessmentId: input.supersedesAssessmentId ?? null,
  }).returning();
  if (!row) throw new Error("native_assessment_not_persisted");
  return row;
}

export async function recordNativeAttentionAssessment(input: {
  db: Db;
  companyId: string;
  issueId: string;
  runId: string;
  turnId: string | null;
  contractId: string;
  resultId: string;
  requestId: string;
  request: Record<string, unknown>;
  routingFacts: Record<string, unknown>;
  priorIssueStatus: string;
  priorStatusVersion: number;
  priorDecisionId: string | null;
  supersedesAssessmentId: string | null;
}) {
  const assessmentJson = {
    kind: "native_attention",
    requestId: input.requestId,
    request: input.request,
    routingFacts: input.routingFacts,
  };
  const inputDigest = nativeSha256({
    companyId: input.companyId,
    issueId: input.issueId,
    runId: input.runId,
    resultId: input.resultId,
    requestId: input.requestId,
    request: input.request,
    routingFacts: input.routingFacts,
    priorIssueStatus: input.priorIssueStatus,
    priorStatusVersion: input.priorStatusVersion,
    priorDecisionId: input.priorDecisionId,
    policyVersion: "phase6-v2",
  });
  const existing = await input.db.select().from(workAssessments).where(and(
    eq(workAssessments.companyId, input.companyId),
    eq(workAssessments.issueId, input.issueId),
    eq(workAssessments.runId, input.runId),
    eq(workAssessments.triggerKind, "native_attention"),
    eq(workAssessments.triggerRef, input.requestId),
  )).limit(1).then((rows) => rows[0] ?? null);
  if (existing) return existing;
  const [row] = await input.db.insert(workAssessments).values({
    companyId: input.companyId,
    issueId: input.issueId,
    runId: input.runId,
    turnId: input.turnId,
    contractId: input.contractId,
    resultId: input.resultId,
    triggerKind: "native_attention",
    triggerRef: input.requestId,
    triggerCapability: "server_native_attention_router",
    triggerActorCompanyId: input.companyId,
    priorIssueStatus: input.priorIssueStatus,
    priorStatusVersion: input.priorStatusVersion,
    priorDecisionId: input.priorDecisionId,
    policyVersion: "phase6-v2",
    assessmentJson,
    inputDigest,
    supersedesAssessmentId: input.supersedesAssessmentId,
  }).returning();
  if (!row) throw new Error("native_attention_assessment_not_persisted");
  return row;
}
