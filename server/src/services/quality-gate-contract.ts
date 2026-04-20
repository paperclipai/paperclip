import { and, desc, eq, inArray, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { documents, issueApprovals, issueDocuments, issueExecutionDecisions, issues } from "@paperclipai/db";
import {
  issueExecutionPolicySchema,
  type IssueExecutionGateContract,
  type IssueExecutionGateKey,
  type IssueExecutionPolicy,
  type IssueExecutionStage,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";

type DbOrTx = Db | any;

type IssueWithPolicy = {
  id: string;
  identifier?: string | null;
  executionPolicy?: IssueExecutionPolicy | Record<string, unknown> | null;
  executionState?: unknown;
};

type ApprovalLike = {
  id?: string;
  payload: Record<string, unknown>;
};

type GateDocument = {
  key: string;
  body: string;
  updatedAt: Date;
};

type GateVerdict = "APPROVED" | "REVISE" | "BLOCKED";

const REVIEW_VERDICT_RE = /(?:^|\n)\s*(?:#{1,6}\s*)?Verdict\s*:\s*(APPROVED|REVISE|BLOCKED)\b/i;
const CLOSEOUT_SECTION_LABELS = {
  changed: "what changed",
  passed: "what passed",
  followUp: "what still needs follow-up",
} as const;

export function parseGateVerdict(body: string): GateVerdict | null {
  const match = REVIEW_VERDICT_RE.exec(body);
  const verdict = match?.[1]?.toUpperCase();
  return verdict === "APPROVED" || verdict === "REVISE" || verdict === "BLOCKED" ? verdict : null;
}

export function isMergeGateApprovalPayload(payload: unknown): payload is Record<string, unknown> {
  return !!payload && typeof payload === "object" && !Array.isArray(payload) && (payload as Record<string, unknown>).stage === "merge_gate";
}

export function getAetherionQualityGateContract(policyInput: unknown): IssueExecutionGateContract | null {
  const parsed = issueExecutionPolicySchema.safeParse(policyInput);
  if (!parsed.success) return null;
  const contract = parsed.data.gateContract ?? null;
  return contract?.kind === "aetherion_quality_funnel" ? contract : null;
}

function parsePolicy(policyInput: unknown): IssueExecutionPolicy | null {
  const parsed = issueExecutionPolicySchema.safeParse(policyInput);
  if (!parsed.success) return null;
  return {
    mode: parsed.data.mode,
    commentRequired: parsed.data.commentRequired,
    gateContract: parsed.data.gateContract ?? null,
    stages: parsed.data.stages
      .filter((stage) => typeof stage.id === "string")
      .map((stage) => ({
        id: stage.id as string,
        type: stage.type,
        gateKey: stage.gateKey ?? null,
        approvalsNeeded: 1 as const,
        participants: stage.participants.map((participant, index) => ({
          id: participant.id ?? `unpersisted-${index}`,
          type: participant.type,
          agentId: participant.agentId ?? null,
          userId: participant.userId ?? null,
        })),
      })),
  };
}

function findStageByGateKey(policy: IssueExecutionPolicy | null, gateKey: IssueExecutionGateKey): IssueExecutionStage | null {
  return policy?.stages.find((stage) => stage.gateKey === gateKey) ?? null;
}

export function getExecutionStageGateContext(policyInput: unknown, stageId: string | null | undefined) {
  const policy = parsePolicy(policyInput);
  if (!policy || !stageId) return null;
  const stage = policy.stages.find((candidate) => candidate.id === stageId) ?? null;
  const contract = getAetherionQualityGateContract(policy);
  return {
    gateKey: stage?.gateKey ?? null,
    gateContractKind: contract?.kind ?? null,
    reviewBudgetsMinutes: contract?.reviewBudgetsMinutes ?? null,
  };
}

async function loadIssueDocuments(db: DbOrTx, issueId: string): Promise<Map<string, GateDocument>> {
  const rows = await db
    .select({
      key: issueDocuments.key,
      body: documents.latestBody,
      updatedAt: documents.updatedAt,
    })
    .from(issueDocuments)
    .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
    .where(eq(issueDocuments.issueId, issueId));
  return new Map(rows.map((row: GateDocument) => [row.key, row]));
}

async function loadIssuesByIds(db: DbOrTx, issueIds: string[]): Promise<IssueWithPolicy[]> {
  if (issueIds.length === 0) return [];
  return db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      executionPolicy: issues.executionPolicy,
      executionState: issues.executionState,
    })
    .from(issues)
    .where(inArray(issues.id, Array.from(new Set(issueIds))));
}

async function loadLinkedApprovalIssues(db: DbOrTx, approvalId: string): Promise<IssueWithPolicy[]> {
  const rows = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      executionPolicy: issues.executionPolicy,
      executionState: issues.executionState,
    })
    .from(issueApprovals)
    .innerJoin(issues, eq(issueApprovals.issueId, issues.id))
    .where(eq(issueApprovals.approvalId, approvalId));
  return rows;
}

function requireDocument(docs: Map<string, GateDocument>, key: string, label: string): GateDocument {
  const doc = docs.get(key);
  if (!doc) {
    throw unprocessable(`Merge gate blocked: missing ${label} artifact`, { missingArtifact: key });
  }
  return doc;
}

function requireApprovedVerdict(doc: GateDocument, label: string) {
  const verdict = parseGateVerdict(doc.body);
  if (verdict !== "APPROVED") {
    throw unprocessable(`Merge gate blocked: ${label} must have Verdict: APPROVED`, {
      artifact: doc.key,
      verdict,
    });
  }
}

function requireUpdatedAfter(newer: GateDocument, older: GateDocument, message: string) {
  if (newer.updatedAt.getTime() <= older.updatedAt.getTime()) {
    throw unprocessable(message, {
      newerArtifact: newer.key,
      newerUpdatedAt: newer.updatedAt,
      olderArtifact: older.key,
      olderUpdatedAt: older.updatedAt,
    });
  }
}

function requireUpdatedAtOrAfter(newer: GateDocument, older: GateDocument, message: string) {
  if (newer.updatedAt.getTime() < older.updatedAt.getTime()) {
    throw unprocessable(message, {
      newerArtifact: newer.key,
      newerUpdatedAt: newer.updatedAt,
      olderArtifact: older.key,
      olderUpdatedAt: older.updatedAt,
    });
  }
}

async function requireApprovedStageDecision(
  db: DbOrTx,
  issue: IssueWithPolicy,
  policy: IssueExecutionPolicy | null,
  gateKey: "adversarial_review" | "code_review",
) {
  const stage = findStageByGateKey(policy, gateKey);
  if (!stage) return;

  const latestDecision = await db
    .select({
      id: issueExecutionDecisions.id,
      outcome: issueExecutionDecisions.outcome,
    })
    .from(issueExecutionDecisions)
    .where(
      and(
        eq(issueExecutionDecisions.issueId, issue.id),
        or(
          eq(issueExecutionDecisions.gateKey, gateKey),
          eq(issueExecutionDecisions.stageId, stage.id),
        ),
      ),
    )
    .orderBy(desc(issueExecutionDecisions.createdAt))
    .then((rows: Array<{ id: string; outcome: string }>) => rows[0] ?? null);

  if (latestDecision?.outcome !== "approved") {
    throw unprocessable(`Merge gate blocked: ${gateKey} execution stage is not approved`, {
      issueId: issue.id,
      stageId: stage.id,
      gateKey,
      latestDecisionOutcome: latestDecision?.outcome ?? null,
    });
  }
}

export async function assertIssueMergeGateReady(db: DbOrTx, issue: IssueWithPolicy) {
  const policy = parsePolicy(issue.executionPolicy);
  const contract = getAetherionQualityGateContract(policy);
  if (!contract) return;

  const docs = await loadIssueDocuments(db, issue.id);
  const keys = contract.artifactKeys;
  const planAudit = requireDocument(docs, keys.planAudit, "plan audit");
  const executionReport = requireDocument(docs, keys.executionReport, "execution report");
  const adversarialReview = requireDocument(docs, keys.adversarialReview, "adversarial review");
  const codeReview = requireDocument(docs, keys.codeReview, "code review");
  const verification = requireDocument(docs, keys.verification, "verification");

  requireApprovedVerdict(adversarialReview, "adversarial review");
  requireApprovedVerdict(codeReview, "code review");
  requireUpdatedAfter(adversarialReview, executionReport, "Merge gate blocked: adversarial review is stale or missing after execution report");
  requireUpdatedAfter(codeReview, adversarialReview, "Merge gate blocked: code review is stale or missing after adversarial review");
  requireUpdatedAtOrAfter(verification, codeReview, "Merge gate blocked: verification is stale or missing after code review");

  await requireApprovedStageDecision(db, issue, policy, "adversarial_review");
  await requireApprovedStageDecision(db, issue, policy, "code_review");

  return { planAudit, executionReport, adversarialReview, codeReview, verification };
}

export async function assertApprovalMergeGateReadyForIssueIds(
  db: DbOrTx,
  approval: ApprovalLike,
  issueIds: string[],
) {
  if (!isMergeGateApprovalPayload(approval.payload)) return;
  const linkedIssues = await loadIssuesByIds(db, issueIds);
  for (const issue of linkedIssues) {
    await assertIssueMergeGateReady(db, issue);
  }
}

export async function assertApprovalMergeGateReadyForIssue(
  db: DbOrTx,
  approval: ApprovalLike,
  issueId: string,
) {
  await assertApprovalMergeGateReadyForIssueIds(db, approval, [issueId]);
}

export async function assertApprovalMergeGateReadyForLinkedIssues(db: DbOrTx, approval: ApprovalLike & { id: string }) {
  if (!isMergeGateApprovalPayload(approval.payload)) return;
  const linkedIssues = await loadLinkedApprovalIssues(db, approval.id);
  for (const issue of linkedIssues) {
    await assertIssueMergeGateReady(db, issue);
  }
}

function matchCloseoutSection(line: string): keyof typeof CLOSEOUT_SECTION_LABELS | null {
  const normalized = line
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/:\s*$/, "")
    .trim()
    .toLowerCase();

  for (const [section, label] of Object.entries(CLOSEOUT_SECTION_LABELS)) {
    if (normalized === label) return section as keyof typeof CLOSEOUT_SECTION_LABELS;
  }
  return null;
}

function hasRequiredCloseoutSections(body: string): boolean {
  const sections: Record<keyof typeof CLOSEOUT_SECTION_LABELS, string[]> = {
    changed: [],
    passed: [],
    followUp: [],
  };
  let currentSection: keyof typeof CLOSEOUT_SECTION_LABELS | null = null;
  for (const line of body.split(/\r?\n/)) {
    const heading = matchCloseoutSection(line);
    if (heading) {
      currentSection = heading;
      continue;
    }
    if (currentSection) {
      sections[currentSection].push(line);
    }
  }

  return Object.values(sections).every((lines) => lines.join("\n").trim().length > 0);
}

export async function assertIssueCanMoveToDone(db: DbOrTx, issue: IssueWithPolicy) {
  const contract = getAetherionQualityGateContract(issue.executionPolicy);
  if (!contract) return;

  const docs = await loadIssueDocuments(db, issue.id);
  const closeout = requireDocument(docs, contract.artifactKeys.closeout, "closeout");
  if (!hasRequiredCloseoutSections(closeout.body)) {
    throw unprocessable("Done blocked: closeout must include non-empty What changed, What passed, and What still needs follow-up evidence", {
      artifact: closeout.key,
    });
  }
}

export async function countPriorChangesRequestedForActiveGateStage(db: DbOrTx, issue: IssueWithPolicy): Promise<number> {
  const policy = parsePolicy(issue.executionPolicy);
  const contract = getAetherionQualityGateContract(policy);
  const state = parseIssueExecutionState(issue.executionState);
  if (!contract || state?.status !== "pending" || !state.currentStageId) return 0;
  const stage = policy?.stages.find((candidate) => candidate.id === state.currentStageId) ?? null;
  if (stage?.gateKey !== "adversarial_review") return 0;

  const rows = await db
    .select({ id: issueExecutionDecisions.id })
    .from(issueExecutionDecisions)
    .where(
      and(
        eq(issueExecutionDecisions.issueId, issue.id),
        or(
          eq(issueExecutionDecisions.gateKey, "adversarial_review"),
          eq(issueExecutionDecisions.stageId, stage.id),
        ),
        eq(issueExecutionDecisions.outcome, "changes_requested"),
      ),
    );
  return rows.length;
}
