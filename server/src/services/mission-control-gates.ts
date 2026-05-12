import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { documents, issueDocuments } from "@paperclipai/db";
import {
  evaluateMissionControlCompletionGate,
  type MissionControlCompletionGateDocument,
  type MissionControlCompletionGateResult,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

export type MissionControlCompletionGateIssue = {
  id: string;
  priority: string;
  executionPolicy?: unknown;
};

export function assertMissionControlCompletionGate(input: {
  issue: MissionControlCompletionGateIssue;
  documents: MissionControlCompletionGateDocument[];
}): MissionControlCompletionGateResult {
  const gate = evaluateMissionControlCompletionGate(input);
  if (gate.allowed) return gate;

  throw unprocessable("Mission-control completion gate blocked issue", {
    reason: gate.reason,
    missingDocumentKeys: gate.missingDocumentKeys,
    validatorVerdict: gate.validatorVerdict,
    ceoLoopDecision: gate.ceoLoopDecision,
    requiredApprovalGate: gate.requiredApprovalGate,
    requiredDocumentKeys: gate.policy?.requiredDocumentKeys ?? [],
    acceptedValidatorVerdicts: gate.policy?.acceptedValidatorVerdicts ?? ["PASS"],
    autonomousLoop: gate.policy?.autonomousLoop ?? null,
  });
}

export function assertMissionControlCompletionTransitionGate(input: {
  issue: MissionControlCompletionGateIssue;
  nextExecutionPolicy?: unknown;
  documents: MissionControlCompletionGateDocument[];
}): MissionControlCompletionGateResult {
  const currentGate = assertMissionControlCompletionGate({
    issue: input.issue,
    documents: input.documents,
  });

  if (input.nextExecutionPolicy === undefined) return currentGate;

  const nextGate = assertMissionControlCompletionGate({
    issue: { ...input.issue, executionPolicy: input.nextExecutionPolicy },
    documents: input.documents,
  });

  return nextGate.enabled ? nextGate : currentGate;
}

export async function listMissionControlCompletionDocuments(
  dbOrTx: Db | any,
  issueId: string,
): Promise<MissionControlCompletionGateDocument[]> {
  const documentsByIssue = await listMissionControlCompletionDocumentsForIssues(dbOrTx, [issueId]);
  return documentsByIssue.get(issueId) ?? [];
}

export async function listMissionControlCompletionDocumentsForIssues(
  dbOrTx: Db | any,
  issueIds: string[],
  options: { companyId?: string; documentKeys?: readonly string[] } = {},
): Promise<Map<string, MissionControlCompletionGateDocument[]>> {
  if (issueIds.length === 0) return new Map();

  const documentKeys = [...new Set(options.documentKeys?.map((key) => key.trim()).filter(Boolean) ?? [])];
  const predicates = [inArray(issueDocuments.issueId, issueIds)];
  if (options.companyId) {
    predicates.push(eq(issueDocuments.companyId, options.companyId));
    predicates.push(eq(documents.companyId, options.companyId));
  }
  if (documentKeys.length > 0) {
    predicates.push(inArray(issueDocuments.key, documentKeys));
  }

  const rows = await dbOrTx
    .select({
      issueId: issueDocuments.issueId,
      key: issueDocuments.key,
      body: documents.latestBody,
      updatedAt: documents.updatedAt,
    })
    .from(issueDocuments)
    .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
    .where(and(...predicates));

  const documentsByIssue = new Map<string, MissionControlCompletionGateDocument[]>();
  for (const row of rows as Array<{
    issueId: string;
    key: string;
    body: string | null;
    updatedAt: Date | string | null;
  }>) {
    const existing = documentsByIssue.get(row.issueId) ?? [];
    existing.push({
      key: row.key,
      body: row.body,
      updatedAt: row.updatedAt,
    });
    documentsByIssue.set(row.issueId, existing);
  }

  return documentsByIssue;
}

export async function assertMissionControlCompletionAllowed(
  dbOrTx: Db | any,
  issue: MissionControlCompletionGateIssue,
  options?: { nextExecutionPolicy?: unknown },
): Promise<MissionControlCompletionGateResult> {
  const documents = await listMissionControlCompletionDocuments(dbOrTx, issue.id);
  return assertMissionControlCompletionTransitionGate({
    issue,
    nextExecutionPolicy: options?.nextExecutionPolicy,
    documents,
  });
}
