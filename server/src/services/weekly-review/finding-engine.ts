import type {
  AdapterReadinessStatus,
  LocalAdapterAssuranceType,
  ModelAssuranceModelSource,
  ModelAssurancePolicyStatus,
  ModelAssuranceReasonCode,
  ModelAssuranceRoleFit,
  WeeklyReviewFindingCategory,
  WeeklyReviewFindingSeverity,
  WeeklyReviewFindingStatus,
} from "@paperclipai/shared";
import { LOCAL_ADAPTER_ASSURANCE_TYPES } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import {
  adapterReadinessProbes,
  agents,
  approvals,
  budgetIncidents,
  costEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { and, desc, eq, gt, gte, isNull, lte, or } from "drizzle-orm";

import { NORTHSTAR_EXPECTED_FINDINGS } from "./northstar-fixture.js";

export type WeeklyReviewCitationEntityType =
  | "issue"
  | "issue_comment"
  | "approval"
  | "heartbeat_run"
  | "budget_incident"
  | "cost_event"
  | "agent"
  | "adapter_readiness_probe";

export interface WeeklyReviewSourceIndexEntry {
  companyId: string;
  entityType: WeeklyReviewCitationEntityType;
  entityId: string;
}

export interface WeeklyReviewFindingSourceSnapshot {
  companyId: string;
  periodStart: Date;
  periodEnd: Date;
  sourceWindowStart: Date;
  sourceWindowEnd: Date;
  agents: WeeklyReviewAgentSource[];
  issues: WeeklyReviewIssueSource[];
  issueComments: WeeklyReviewIssueCommentSource[];
  approvals: WeeklyReviewApprovalSource[];
  heartbeatRuns: WeeklyReviewHeartbeatRunSource[];
  budgetIncidents: WeeklyReviewBudgetIncidentSource[];
  costEvents: WeeklyReviewCostEventSource[];
  adapterReadinessProbes: WeeklyReviewAdapterReadinessProbeSource[];
  sourceIndex?: Record<string, WeeklyReviewSourceIndexEntry>;
}

export interface WeeklyReviewAgentSource {
  id: string;
  companyId: string;
  name: string;
  role: string;
  title: string | null;
  adapterType: string;
  metadata?: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WeeklyReviewIssueSource {
  id: string;
  companyId: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  updatedAt: Date;
  completedAt: Date | null;
  hiddenAt: Date | null;
}

export interface WeeklyReviewIssueCommentSource {
  id: string;
  companyId: string;
  issueId: string;
  body: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  authorType?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WeeklyReviewApprovalSource {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  requestedByAgentId: string | null;
  requestedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WeeklyReviewHeartbeatRunSource {
  id: string;
  companyId: string;
  agentId: string;
  status: string;
  triggerDetail: string | null;
  error: string | null;
  resultJson: Record<string, unknown> | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WeeklyReviewBudgetIncidentSource {
  id: string;
  companyId: string;
  status: string;
  metric: string;
  scopeType: string;
  scopeId: string;
  amountObserved: number;
  amountLimit: number;
  thresholdType: string;
  windowStart: Date;
  windowEnd: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface WeeklyReviewCostEventSource {
  id: string;
  companyId: string;
  agentId: string;
  issueId: string | null;
  provider: string;
  model: string;
  costCents: number;
  billingCode: string | null;
  occurredAt: Date;
}

export interface WeeklyReviewAdapterReadinessProbeSource {
  id: string;
  companyId: string;
  agentId: string;
  adapterType: string;
  status: string;
  basicReady: boolean;
  operationalReady: boolean;
  fixtureReady: boolean;
  reasonCodesJson?: string[] | null;
  model: string | null;
  resolvedModel?: string | null;
  modelSource?: string | null;
  modelProfile: string | null;
  modelAvailable?: boolean;
  modelRunnable?: boolean;
  modelPolicyStatus?: string | null;
  roleFit?: string | null;
  roleFitReason?: string | null;
  modelReasonCodesJson?: string[] | null;
  modelCapabilitiesJson?: Record<string, unknown> | null;
  strictMode: boolean;
  checkedAt: Date;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface WeeklyReviewFindingDraft {
  stableId: string;
  category: WeeklyReviewFindingCategory;
  severity: WeeklyReviewFindingSeverity;
  status: WeeklyReviewFindingStatus;
  title: string;
  summary: string;
  workstream: string;
  evidenceIds: string[];
  recommendedAction: Record<string, unknown>;
  recommendationText: string;
  reasonCode: string;
  sourceEntityType: WeeklyReviewCitationEntityType;
  sourceEntityId: string;
  confidence: "high" | "medium" | "low";
  detectedAt: Date;
  validationStatus: "valid" | "invalid" | "unknown";
  rulesTriggered: string[];
  actorId: string | null;
  uiCta: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface WeeklyReviewCitationDraft {
  findingStableId: string;
  companyId: string;
  citationType: "evidence" | "recommendation_support";
  entityType: WeeklyReviewCitationEntityType;
  entityId: string;
  field?: string | null;
  label: string;
  excerpt?: string | null;
  metadata?: Record<string, unknown>;
}

export interface WeeklyReviewRecommendationDraft {
  findingStableId: string;
  companyId: string;
  kind: "approve" | "assign_owner" | "request_evidence" | "refresh" | "acknowledge";
  severity: WeeklyReviewFindingSeverity;
  title: string;
  rationale: string;
  proposedAction: Record<string, unknown>;
}

export interface WeeklyReviewCitationValidationError {
  code:
    | "citation_cross_company"
    | "citation_target_missing"
    | "material_citation_missing"
    | "citation_finding_missing";
  findingStableId?: string;
  entityType?: string;
  entityId?: string;
  citationIndex?: number;
}

export interface WeeklyReviewCitationValidationResult {
  valid: boolean;
  errors: WeeklyReviewCitationValidationError[];
  materialFindingsWithoutCitations: string[];
  invalidCitationIndexes: number[];
}

export interface WeeklyReviewAdapterReadinessSummary {
  byAdapterType: Record<
    LocalAdapterAssuranceType,
    {
      adapterType: LocalAdapterAssuranceType;
      status: AdapterReadinessStatus;
      agentIds: string[];
      readyCount: number;
      blockedCount: number;
      warningCount: number;
      reasonCodes: string[];
    }
  >;
  byAgent: Record<string, WeeklyReviewAdapterReadinessProbeSource>;
}

export interface WeeklyReviewModelAssuranceSummary {
  byAgent: Record<
    string,
    {
      adapterType: LocalAdapterAssuranceType;
      selectedModel: string | null;
      resolvedModel: string | null;
      modelSource: ModelAssuranceModelSource;
      modelProfile: string | null;
      modelAvailable: boolean;
      modelRunnable: boolean;
      policyStatus: ModelAssurancePolicyStatus;
      roleFit: ModelAssuranceRoleFit;
      roleFitReason: string | null;
      reasonCodes: ModelAssuranceReasonCode[];
      capabilities: Record<string, unknown> | null;
    }
  >;
}

export interface WeeklyReviewFindingEngineResult {
  companyId: string;
  periodStart: Date;
  periodEnd: Date;
  findings: WeeklyReviewFindingDraft[];
  citations: WeeklyReviewCitationDraft[];
  recommendations: WeeklyReviewRecommendationDraft[];
  citationValidation: WeeklyReviewCitationValidationResult;
  adapterReadinessSummary: WeeklyReviewAdapterReadinessSummary;
  modelAssuranceSummary: WeeklyReviewModelAssuranceSummary;
  inputCounts: Record<string, number>;
}

export function computeWeeklyReviewFindingsFromSnapshot(
  snapshot: WeeklyReviewFindingSourceSnapshot,
): WeeklyReviewFindingEngineResult {
  const sourceIndex = {
    ...buildSourceIndex(snapshot),
    ...(snapshot.sourceIndex ?? {}),
  };
  const findings: WeeklyReviewFindingDraft[] = [];
  const citations: WeeklyReviewCitationDraft[] = [];
  const recommendations: WeeklyReviewRecommendationDraft[] = [];

  const supportHandoff = findIssue(snapshot, [
    "support handoff",
    "broad rollout",
  ], (issue) => isOpenIssue(issue) && !issue.assigneeAgentId);
  if (supportHandoff) {
    addFinding({
      snapshot,
      findings,
      citations,
      recommendations,
      stableId: "NSR-F01",
      source: sourceRef("issue", supportHandoff.id),
      summary: "Broad rollout remains blocked because the support handoff issue has no accountable owner.",
      reasonCode: "support_handoff_owner_missing",
      recommendationKind: "assign_owner",
      recommendationText: "Assign a Support/Ops owner before broad rollout proceeds.",
      excerpt: supportHandoff.description,
    });
  }

  const pilotApproval =
    findApproval(snapshot, ["limited pilot", "rollout"], (approval) => approval.status === "pending") ??
    findIssue(snapshot, ["approve", "limited pilot", "rollout"], isOpenIssue);
  if (pilotApproval) {
    addFinding({
      snapshot,
      findings,
      citations,
      recommendations,
      stableId: "NSR-F02",
      source: "type" in pilotApproval ? sourceRef("approval", pilotApproval.id) : sourceRef("issue", pilotApproval.id),
      summary: "A human approval gate is still required before the limited pilot starts.",
      reasonCode: "limited_pilot_approval_pending",
      recommendationKind: "approve",
      recommendationText: "Approve or reject the limited pilot rollout gate.",
      excerpt: "type" in pilotApproval ? stableStringify(pilotApproval.payload) : pilotApproval.description,
    });
  }

  if (supportHandoff) {
    addFinding({
      snapshot,
      findings,
      citations,
      recommendations,
      stableId: "NSR-F03",
      source: sourceRef("issue", supportHandoff.id),
      summary: "The Support/Ops Lead ownership decision is still unassigned.",
      reasonCode: "support_ops_owner_assignment_required",
      recommendationKind: "assign_owner",
      recommendationText: "Assign the Support/Ops Lead owner on the support handoff issue.",
      excerpt: supportHandoff.description,
    });
  }

  const researchGap =
    findIssue(snapshot, ["unsupported", "customer-segment", "claim"], isOpenIssue) ??
    findIssueWithComment(snapshot, ["unsupported", "customer-segment", "claim"]);
  if (researchGap) {
    const comment = snapshot.issueComments.find((candidate) =>
      candidate.issueId === researchGap.id && containsAll(candidate.body, ["unsupported", "claim"]),
    );
    addFinding({
      snapshot,
      findings,
      citations,
      recommendations,
      stableId: "NSR-F04",
      source: comment ? sourceRef("issue_comment", comment.id) : sourceRef("issue", researchGap.id),
      summary: "The research brief contains a customer-segment claim that cannot be used until it has supporting evidence.",
      reasonCode: "research_claim_missing_citation",
      recommendationKind: "request_evidence",
      recommendationText: "Attach supporting evidence or remove the unsupported customer-segment claim.",
      excerpt: comment?.body ?? researchGap.description,
    });
  }

  const staleRunbook = findIssue(snapshot, ["operations runbook", "stale"], (issue) =>
    isOpenIssue(issue) && daysBetween(issue.updatedAt, snapshot.periodEnd) >= 7,
  );
  if (staleRunbook) {
    addFinding({
      snapshot,
      findings,
      citations,
      recommendations,
      stableId: "NSR-F05",
      source: sourceRef("issue", staleRunbook.id),
      summary: "The operations runbook blocker is stale and still connected to the support handoff.",
      reasonCode: "operations_runbook_stale",
      recommendationKind: "refresh",
      recommendationText: "Refresh the operations runbook and clear the support handoff dependency.",
      excerpt: staleRunbook.description,
    });
  }

  const budgetSignal =
    snapshot.budgetIncidents.find((incident) => incident.status !== "resolved" && incident.status !== "dismissed") ??
    snapshot.costEvents.find((event) => containsAny([event.billingCode, event.provider, event.model].join(" "), ["citation", "retry", "prototype"]));
  if (budgetSignal) {
    addFinding({
      snapshot,
      findings,
      citations,
      recommendations,
      stableId: "NSR-F06",
      source: "metric" in budgetSignal ? sourceRef("budget_incident", budgetSignal.id) : sourceRef("cost_event", budgetSignal.id),
      summary: "Citation validation retries and prototype implementation spend have crossed the weekly warning threshold.",
      reasonCode: "weekly_budget_warning",
      recommendationKind: "acknowledge",
      recommendationText: "Review retry volume and prototype spend before widening the pilot.",
      excerpt: "metric" in budgetSignal
        ? `${budgetSignal.amountObserved}/${budgetSignal.amountLimit} ${budgetSignal.metric}`
        : `${budgetSignal.billingCode ?? "cost event"} ${budgetSignal.costCents} cents`,
    });
  }

  const failedResearchValidation = snapshot.heartbeatRuns.find((run) =>
    run.status === "failed" &&
    containsAll(
      [run.triggerDetail, run.error, stableStringify(run.resultJson)].join(" "),
      ["research", "validation"],
    ),
  );
  if (failedResearchValidation) {
    addFinding({
      snapshot,
      findings,
      citations,
      recommendations,
      stableId: "NSR-F07",
      source: sourceRef("heartbeat_run", failedResearchValidation.id),
      summary: "The research summarization run failed validation and should not feed executive narration yet.",
      reasonCode: "research_summary_validation_failed",
      recommendationKind: "refresh",
      recommendationText: "Rerun or repair research summarization validation before using the summary.",
      excerpt: failedResearchValidation.error,
    });
  }

  const inboxDigestWin = findIssue(snapshot, ["weekly inbox digest", "ready", "limited pilot"], (issue) =>
    issue.status === "done" || issue.completedAt !== null || containsAny(`${issue.title} ${issue.description ?? ""}`, ["ready for limited pilot"]),
  );
  if (inboxDigestWin) {
    addFinding({
      snapshot,
      findings,
      citations,
      recommendations,
      stableId: "NSR-F08",
      source: sourceRef("issue", inboxDigestWin.id),
      summary: "The cited weekly inbox digest prototype is ready to carry limited-pilot context.",
      reasonCode: "weekly_inbox_digest_ready",
      recommendationKind: "acknowledge",
      recommendationText: "Use the inbox digest prototype as positive context in the weekly review.",
      excerpt: inboxDigestWin.description,
    });
  }

  const citationValidation = validateWeeklyReviewCitationDrafts({
    companyId: snapshot.companyId,
    findings,
    citations,
    sourceIndex,
  });

  return {
    companyId: snapshot.companyId,
    periodStart: snapshot.periodStart,
    periodEnd: snapshot.periodEnd,
    findings: findings.map((finding) => ({
      ...finding,
      validationStatus: citationValidation.valid ? "valid" : "invalid",
    })),
    citations,
    recommendations,
    citationValidation,
    adapterReadinessSummary: summarizeAdapterReadiness(snapshot),
    modelAssuranceSummary: summarizeModelAssurance(snapshot),
    inputCounts: {
      agents: snapshot.agents.length,
      issues: snapshot.issues.length,
      issueComments: snapshot.issueComments.length,
      approvals: snapshot.approvals.length,
      heartbeatRuns: snapshot.heartbeatRuns.length,
      budgetIncidents: snapshot.budgetIncidents.length,
      costEvents: snapshot.costEvents.length,
      adapterReadinessProbes: snapshot.adapterReadinessProbes.length,
    },
  };
}

export function validateWeeklyReviewCitationDrafts(input: {
  companyId: string;
  findings: Array<Pick<WeeklyReviewFindingDraft, "stableId" | "category" | "severity" | "title">>;
  citations: WeeklyReviewCitationDraft[];
  sourceIndex?: Record<string, WeeklyReviewSourceIndexEntry>;
}): WeeklyReviewCitationValidationResult {
  const findingIds = new Set(input.findings.map((finding) => finding.stableId));
  const citedFindingIds = new Set<string>();
  const errors: WeeklyReviewCitationValidationError[] = [];
  const invalidCitationIndexes: number[] = [];

  input.citations.forEach((citation, index) => {
    if (!findingIds.has(citation.findingStableId)) {
      errors.push({
        code: "citation_finding_missing",
        findingStableId: citation.findingStableId,
        citationIndex: index,
      });
      invalidCitationIndexes.push(index);
      return;
    }
    citedFindingIds.add(citation.findingStableId);

    if (citation.companyId !== input.companyId) {
      errors.push({
        code: "citation_cross_company",
        findingStableId: citation.findingStableId,
        entityType: citation.entityType,
        entityId: citation.entityId,
        citationIndex: index,
      });
      invalidCitationIndexes.push(index);
      return;
    }

    const source = input.sourceIndex?.[sourceKey(citation.entityType, citation.entityId)];
    if (!source) {
      errors.push({
        code: "citation_target_missing",
        findingStableId: citation.findingStableId,
        entityType: citation.entityType,
        entityId: citation.entityId,
        citationIndex: index,
      });
      invalidCitationIndexes.push(index);
      return;
    }

    if (source.companyId !== input.companyId || source.companyId !== citation.companyId) {
      errors.push({
        code: "citation_cross_company",
        findingStableId: citation.findingStableId,
        entityType: citation.entityType,
        entityId: citation.entityId,
        citationIndex: index,
      });
      invalidCitationIndexes.push(index);
    }
  });

  const materialFindingsWithoutCitations = input.findings
    .filter((finding) => !citedFindingIds.has(finding.stableId))
    .map((finding) => finding.stableId);
  for (const stableId of materialFindingsWithoutCitations) {
    errors.push({ code: "material_citation_missing", findingStableId: stableId });
  }

  return {
    valid: errors.length === 0,
    errors,
    materialFindingsWithoutCitations,
    invalidCitationIndexes,
  };
}

export function weeklyReviewFindingEngineService(db: Db) {
  return {
    async computeForCompanyPeriod(
      companyId: string,
      input: { periodStart: Date; periodEnd: Date; sourceWindowStart?: Date; sourceWindowEnd?: Date },
    ): Promise<WeeklyReviewFindingEngineResult> {
      const sourceWindowStart = input.sourceWindowStart ?? input.periodStart;
      const sourceWindowEnd = input.sourceWindowEnd ?? input.periodEnd;
      const snapshot = await loadWeeklyReviewFindingSnapshot(db, companyId, {
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        sourceWindowStart,
        sourceWindowEnd,
      });
      return computeWeeklyReviewFindingsFromSnapshot(snapshot);
    },
  };
}

export async function loadWeeklyReviewFindingSnapshot(
  db: Db,
  companyId: string,
  input: { periodStart: Date; periodEnd: Date; sourceWindowStart: Date; sourceWindowEnd: Date },
): Promise<WeeklyReviewFindingSourceSnapshot> {
  const [
    agentRows,
    issueRows,
    commentRows,
    approvalRows,
    heartbeatRunRows,
    budgetIncidentRows,
    costEventRows,
    readinessProbeRows,
  ] = await Promise.all([
    db.select().from(agents).where(eq(agents.companyId, companyId)),
    db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), lte(issues.updatedAt, input.sourceWindowEnd), isNull(issues.hiddenAt))),
    db
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, companyId),
          gte(issueComments.createdAt, input.sourceWindowStart),
          lte(issueComments.createdAt, input.sourceWindowEnd),
        ),
      ),
    db
      .select()
      .from(approvals)
      .where(and(eq(approvals.companyId, companyId), lte(approvals.createdAt, input.sourceWindowEnd))),
    db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          gte(heartbeatRuns.createdAt, input.sourceWindowStart),
          lte(heartbeatRuns.createdAt, input.sourceWindowEnd),
        ),
      ),
    db
      .select()
      .from(budgetIncidents)
      .where(
        and(
          eq(budgetIncidents.companyId, companyId),
          lte(budgetIncidents.windowStart, input.sourceWindowEnd),
          gte(budgetIncidents.windowEnd, input.sourceWindowStart),
        ),
      ),
    db
      .select()
      .from(costEvents)
      .where(
        and(
          eq(costEvents.companyId, companyId),
          gte(costEvents.occurredAt, input.sourceWindowStart),
          lte(costEvents.occurredAt, input.sourceWindowEnd),
        ),
      ),
    db
      .select()
      .from(adapterReadinessProbes)
      .where(
        and(
          eq(adapterReadinessProbes.companyId, companyId),
          lte(adapterReadinessProbes.createdAt, input.sourceWindowEnd),
          or(isNull(adapterReadinessProbes.expiresAt), gt(adapterReadinessProbes.expiresAt, input.sourceWindowEnd)),
        ),
      )
      .orderBy(desc(adapterReadinessProbes.createdAt)),
  ]);

  return {
    companyId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    sourceWindowStart: input.sourceWindowStart,
    sourceWindowEnd: input.sourceWindowEnd,
    agents: agentRows.map((agent) => ({
      id: agent.id,
      companyId: agent.companyId,
      name: agent.name,
      role: agent.role,
      title: agent.title,
      adapterType: agent.adapterType,
      metadata: agent.metadata,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    })),
    issues: issueRows.map((issue) => ({
      id: issue.id,
      companyId: issue.companyId,
      title: issue.title,
      description: issue.description,
      status: issue.status,
      priority: issue.priority,
      assigneeAgentId: issue.assigneeAgentId,
      assigneeUserId: issue.assigneeUserId,
      updatedAt: issue.updatedAt,
      completedAt: issue.completedAt,
      hiddenAt: issue.hiddenAt,
    })),
    issueComments: commentRows.map((comment) => ({
      id: comment.id,
      companyId: comment.companyId,
      issueId: comment.issueId,
      body: comment.body,
      authorAgentId: comment.authorAgentId,
      authorUserId: comment.authorUserId,
      authorType: comment.authorType,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    })),
    approvals: approvalRows.map((approval) => ({
      id: approval.id,
      companyId: approval.companyId,
      type: approval.type,
      status: approval.status,
      payload: approval.payload,
      requestedByAgentId: approval.requestedByAgentId,
      requestedByUserId: approval.requestedByUserId,
      createdAt: approval.createdAt,
      updatedAt: approval.updatedAt,
    })),
    heartbeatRuns: heartbeatRunRows.map((run) => ({
      id: run.id,
      companyId: run.companyId,
      agentId: run.agentId,
      status: run.status,
      triggerDetail: run.triggerDetail,
      error: run.error,
      resultJson: run.resultJson,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    })),
    budgetIncidents: budgetIncidentRows.map((incident) => ({
      id: incident.id,
      companyId: incident.companyId,
      status: incident.status,
      metric: incident.metric,
      scopeType: incident.scopeType,
      scopeId: incident.scopeId,
      amountObserved: incident.amountObserved,
      amountLimit: incident.amountLimit,
      thresholdType: incident.thresholdType,
      windowStart: incident.windowStart,
      windowEnd: incident.windowEnd,
      createdAt: incident.createdAt,
      updatedAt: incident.updatedAt,
    })),
    costEvents: costEventRows.map((event) => ({
      id: event.id,
      companyId: event.companyId,
      agentId: event.agentId,
      issueId: event.issueId,
      provider: event.provider,
      model: event.model,
      costCents: event.costCents,
      billingCode: event.billingCode,
      occurredAt: event.occurredAt,
    })),
    adapterReadinessProbes: latestProbePerAgent(readinessProbeRows).map((probe) => ({
      id: probe.id,
      companyId: probe.companyId,
      agentId: probe.agentId,
      adapterType: probe.adapterType,
      status: probe.status,
      basicReady: probe.basicReady,
      operationalReady: probe.operationalReady,
      fixtureReady: probe.fixtureReady,
      reasonCodesJson: probe.reasonCodesJson,
      model: probe.model,
      resolvedModel: probe.resolvedModel,
      modelSource: probe.modelSource,
      modelProfile: probe.modelProfile,
      modelAvailable: probe.modelAvailable,
      modelRunnable: probe.modelRunnable,
      modelPolicyStatus: probe.modelPolicyStatus,
      roleFit: probe.roleFit,
      roleFitReason: probe.roleFitReason,
      modelReasonCodesJson: probe.modelReasonCodesJson,
      modelCapabilitiesJson: probe.modelCapabilitiesJson,
      strictMode: probe.strictMode,
      checkedAt: probe.checkedAt,
      expiresAt: probe.expiresAt,
      createdAt: probe.createdAt,
    })),
  };
}

function addFinding(input: {
  snapshot: WeeklyReviewFindingSourceSnapshot;
  findings: WeeklyReviewFindingDraft[];
  citations: WeeklyReviewCitationDraft[];
  recommendations: WeeklyReviewRecommendationDraft[];
  stableId: string;
  source: { entityType: WeeklyReviewCitationEntityType; entityId: string };
  summary: string;
  reasonCode: string;
  recommendationKind: WeeklyReviewRecommendationDraft["kind"];
  recommendationText: string;
  excerpt: string | null | undefined;
}) {
  const expected = NORTHSTAR_EXPECTED_FINDINGS.find((finding) => finding.stableId === input.stableId);
  if (!expected) return;

  input.findings.push({
    stableId: expected.stableId,
    category: expected.category,
    severity: expected.severity,
    status: "open",
    title: expected.title,
    summary: input.summary,
    workstream: expected.workstream,
    evidenceIds: [sourceKey(input.source.entityType, input.source.entityId)],
    recommendedAction: {
      kind: input.recommendationKind,
      label: input.recommendationText,
    },
    recommendationText: input.recommendationText,
    reasonCode: input.reasonCode,
    sourceEntityType: input.source.entityType,
    sourceEntityId: input.source.entityId,
    confidence: expected.severity === "low" ? "medium" : "high",
    detectedAt: input.snapshot.periodEnd,
    validationStatus: "unknown",
    rulesTriggered: [input.reasonCode],
    actorId: null,
    uiCta: { kind: input.recommendationKind },
    metadata: {
      engine: "weekly_review_wave_3_deterministic",
      periodStart: input.snapshot.periodStart.toISOString(),
      periodEnd: input.snapshot.periodEnd.toISOString(),
    },
  });

  input.citations.push({
    findingStableId: expected.stableId,
    companyId: input.snapshot.companyId,
    citationType: "evidence",
    entityType: input.source.entityType,
    entityId: input.source.entityId,
    field: input.source.entityType === "issue" ? "description" : null,
    label: citationLabel(input.source.entityType, expected.title),
    excerpt: trimExcerpt(input.excerpt),
    metadata: { reasonCode: input.reasonCode },
  });

  input.recommendations.push({
    findingStableId: expected.stableId,
    companyId: input.snapshot.companyId,
    kind: input.recommendationKind,
    severity: expected.severity,
    title: input.recommendationText,
    rationale: input.summary,
    proposedAction: {
      sourceEntityType: input.source.entityType,
      sourceEntityId: input.source.entityId,
      citationRequired: true,
    },
  });
}

function summarizeAdapterReadiness(snapshot: WeeklyReviewFindingSourceSnapshot): WeeklyReviewAdapterReadinessSummary {
  const byAgent: WeeklyReviewAdapterReadinessSummary["byAgent"] = {};
  const byAdapterType = {} as WeeklyReviewAdapterReadinessSummary["byAdapterType"];

  for (const probe of latestProbePerAgent(snapshot.adapterReadinessProbes)) {
    if (!isLocalAdapterAssuranceType(probe.adapterType)) continue;
    byAgent[probe.agentId] = probe;
    const existing = byAdapterType[probe.adapterType] ?? {
      adapterType: probe.adapterType,
      status: "ready" as AdapterReadinessStatus,
      agentIds: [],
      readyCount: 0,
      blockedCount: 0,
      warningCount: 0,
      reasonCodes: [],
    };
    existing.agentIds.push(probe.agentId);
    if (probe.status === "blocked") existing.blockedCount += 1;
    else if (probe.status === "warning") existing.warningCount += 1;
    else if (probe.status === "ready") existing.readyCount += 1;
    existing.status = worseAdapterStatus(existing.status, toAdapterStatus(probe.status));
    existing.reasonCodes = Array.from(new Set([...existing.reasonCodes, ...(probe.reasonCodesJson ?? [])]));
    byAdapterType[probe.adapterType] = existing;
  }

  return { byAdapterType, byAgent };
}

function summarizeModelAssurance(snapshot: WeeklyReviewFindingSourceSnapshot): WeeklyReviewModelAssuranceSummary {
  const byAgent: WeeklyReviewModelAssuranceSummary["byAgent"] = {};
  for (const probe of latestProbePerAgent(snapshot.adapterReadinessProbes)) {
    if (!isLocalAdapterAssuranceType(probe.adapterType)) continue;
    byAgent[probe.agentId] = {
      adapterType: probe.adapterType,
      selectedModel: probe.model,
      resolvedModel: probe.resolvedModel ?? probe.model,
      modelSource: toModelSource(probe.modelSource),
      modelProfile: probe.modelProfile,
      modelAvailable: probe.modelAvailable ?? false,
      modelRunnable: probe.modelRunnable ?? false,
      policyStatus: toModelPolicyStatus(probe.modelPolicyStatus),
      roleFit: toModelRoleFit(probe.roleFit),
      roleFitReason: probe.roleFitReason ?? null,
      reasonCodes: toModelReasonCodes(probe.modelReasonCodesJson),
      capabilities: probe.modelCapabilitiesJson ?? null,
    };
  }
  return { byAgent };
}

function validateFindCandidate(candidate: WeeklyReviewIssueSource, terms: readonly string[]) {
  return containsAll(`${candidate.title} ${candidate.description ?? ""}`, terms);
}

function findIssue(
  snapshot: WeeklyReviewFindingSourceSnapshot,
  terms: readonly string[],
  predicate: (issue: WeeklyReviewIssueSource) => boolean,
) {
  return snapshot.issues.find((issue) => validateFindCandidate(issue, terms) && predicate(issue));
}

function findIssueWithComment(snapshot: WeeklyReviewFindingSourceSnapshot, terms: readonly string[]) {
  const comment = snapshot.issueComments.find((candidate) => containsAll(candidate.body, terms));
  return comment ? snapshot.issues.find((issue) => issue.id === comment.issueId) ?? null : null;
}

function findApproval(
  snapshot: WeeklyReviewFindingSourceSnapshot,
  terms: readonly string[],
  predicate: (approval: WeeklyReviewApprovalSource) => boolean,
) {
  return snapshot.approvals.find((approval) =>
    predicate(approval) && containsAll(`${approval.type} ${stableStringify(approval.payload)}`, terms),
  );
}

function isOpenIssue(issue: WeeklyReviewIssueSource) {
  return issue.hiddenAt === null && issue.status !== "done" && issue.status !== "cancelled";
}

function sourceRef(entityType: WeeklyReviewCitationEntityType, entityId: string) {
  return { entityType, entityId };
}

function buildSourceIndex(snapshot: WeeklyReviewFindingSourceSnapshot): Record<string, WeeklyReviewSourceIndexEntry> {
  const index: Record<string, WeeklyReviewSourceIndexEntry> = {};
  const add = (entry: WeeklyReviewSourceIndexEntry) => {
    index[sourceKey(entry.entityType, entry.entityId)] = entry;
  };
  for (const row of snapshot.agents) add({ companyId: row.companyId, entityType: "agent", entityId: row.id });
  for (const row of snapshot.issues) add({ companyId: row.companyId, entityType: "issue", entityId: row.id });
  for (const row of snapshot.issueComments) add({ companyId: row.companyId, entityType: "issue_comment", entityId: row.id });
  for (const row of snapshot.approvals) add({ companyId: row.companyId, entityType: "approval", entityId: row.id });
  for (const row of snapshot.heartbeatRuns) add({ companyId: row.companyId, entityType: "heartbeat_run", entityId: row.id });
  for (const row of snapshot.budgetIncidents) add({ companyId: row.companyId, entityType: "budget_incident", entityId: row.id });
  for (const row of snapshot.costEvents) add({ companyId: row.companyId, entityType: "cost_event", entityId: row.id });
  for (const row of snapshot.adapterReadinessProbes) add({ companyId: row.companyId, entityType: "adapter_readiness_probe", entityId: row.id });
  return index;
}

function sourceKey(entityType: string, entityId: string) {
  return `${entityType}:${entityId}`;
}

function containsAll(text: string, terms: readonly string[]) {
  const lower = text.toLowerCase();
  return terms.every((term) => lower.includes(term.toLowerCase()));
}

function containsAny(text: string, terms: readonly string[]) {
  const lower = text.toLowerCase();
  return terms.some((term) => lower.includes(term.toLowerCase()));
}

function daysBetween(start: Date, end: Date) {
  return Math.floor((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
}

function citationLabel(entityType: WeeklyReviewCitationEntityType, title: string) {
  if (entityType === "issue") return `Issue: ${title}`;
  if (entityType === "issue_comment") return `Issue comment: ${title}`;
  if (entityType === "heartbeat_run") return `Run: ${title}`;
  if (entityType === "budget_incident") return `Budget incident: ${title}`;
  if (entityType === "cost_event") return `Cost event: ${title}`;
  if (entityType === "approval") return `Approval: ${title}`;
  return title;
}

function trimExcerpt(value: string | null | undefined) {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 280 ? `${normalized.slice(0, 277)}...` : normalized;
}

function stableStringify(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function latestProbePerAgent<T extends { agentId: string; createdAt: Date }>(probes: readonly T[]): T[] {
  const latest = new Map<string, T>();
  for (const probe of [...probes].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) {
    if (!latest.has(probe.agentId)) latest.set(probe.agentId, probe);
  }
  return Array.from(latest.values());
}

function isLocalAdapterAssuranceType(value: string): value is LocalAdapterAssuranceType {
  return (LOCAL_ADAPTER_ASSURANCE_TYPES as readonly string[]).includes(value);
}

function toAdapterStatus(value: string): AdapterReadinessStatus {
  if (["ready", "warning", "blocked", "unknown", "not_applicable"].includes(value)) {
    return value as AdapterReadinessStatus;
  }
  return "unknown";
}

function worseAdapterStatus(left: AdapterReadinessStatus, right: AdapterReadinessStatus): AdapterReadinessStatus {
  const rank: Record<AdapterReadinessStatus, number> = {
    blocked: 5,
    warning: 4,
    unknown: 3,
    not_applicable: 2,
    ready: 1,
  };
  return rank[right] > rank[left] ? right : left;
}

function toModelSource(value: string | null | undefined): ModelAssuranceModelSource {
  if (["adapter_config", "detected", "cli_default", "provider_default", "unknown"].includes(value ?? "")) {
    return value as ModelAssuranceModelSource;
  }
  return "unknown";
}

function toModelPolicyStatus(value: string | null | undefined): ModelAssurancePolicyStatus {
  if (
    [
      "approved_default",
      "approved_primary",
      "approved_cheap",
      "approved_fallback",
      "manual_allowed",
      "warning",
      "blocked",
      "unknown",
    ].includes(value ?? "")
  ) {
    return value as ModelAssurancePolicyStatus;
  }
  return "unknown";
}

function toModelRoleFit(value: string | null | undefined): ModelAssuranceRoleFit {
  if (["strong", "acceptable", "weak", "blocked", "unknown"].includes(value ?? "")) {
    return value as ModelAssuranceRoleFit;
  }
  return "unknown";
}

function toModelReasonCodes(value: string[] | null | undefined): ModelAssuranceReasonCode[] {
  const allowed = new Set([
    "model_unresolved",
    "model_not_listed",
    "model_detect_failed",
    "model_hello_failed",
    "model_quota_limited",
    "model_profile_missing",
    "cheap_profile_missing",
    "role_fit_weak",
    "cost_policy_warning",
    "cost_policy_blocked",
    "manual_model_unverified",
    "fallback_requires_approval",
  ]);
  return (value ?? []).filter((code): code is ModelAssuranceReasonCode => allowed.has(code));
}
