import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, issueApprovals, issues, issueWorkProducts } from "@paperclipai/db";
import type {
  OwnerAckApprovalSummary,
  OwnerAckAuditIssue,
  OwnerAckAuditReport,
  OwnerAckAuditStatus,
  OwnerAckDangerousActionMarker,
  OwnerAckDangerousActionType,
} from "@paperclipai/shared";
import { evaluateOwnerAckGate } from "./owner-ack-gate.js";

type IssueRow = typeof issues.$inferSelect;
type WorkProductRow = typeof issueWorkProducts.$inferSelect;

type LinkedApprovalRow = {
  issueId: string;
  id: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  decisionNote: string | null;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const ACTION_TYPES: OwnerAckDangerousActionType[] = ["deploy", "schema_migration", "external_capability"];

function compactLine(value: string | null | undefined) {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length > 240 ? `${normalized.slice(0, 237).trimEnd()}...` : normalized;
}

function normalizeActionType(value: unknown): OwnerAckDangerousActionType | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "deploy" || normalized === "deployment" || normalized === "production_deploy") return "deploy";
  if (normalized === "schema_migration" || normalized === "migration" || normalized === "database_migration") {
    return "schema_migration";
  }
  if (normalized === "external_capability" || normalized === "external_capability_use") {
    return "external_capability";
  }
  return null;
}

function firstString(payload: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function truthy(value: unknown) {
  return value === true || value === "true" || value === "yes" || value === "required";
}

function normalizeMarkerValue(value: string) {
  return value.trim().toLowerCase().replace(/[.\s]+/g, " ");
}

function shouldAddBooleanStyleMarker(value: string | undefined) {
  if (!value) return false;
  const normalized = normalizeMarkerValue(value);
  const alnumKey = normalized.replace(/[^a-z0-9]/g, "");
  if (!normalized) return false;
  if (normalized === "yes" || normalized === "required" || normalized === "true") return true;
  if (
    normalized === "none"
    || normalized === "no"
    || normalized === "false"
    || normalized === "n/a"
    || normalized === "na"
    || alnumKey === "na"
    || normalized === "0"
    || normalized === "not required"
    || alnumKey === "notrequired"
  ) {
    return false;
  }
  return /[a-z0-9]/i.test(normalized);
}

function extractIssueTextMarkers(issue: IssueRow): OwnerAckDangerousActionMarker[] {
  const text = `${issue.title}\n${issue.description ?? ""}`;
  const markers: OwnerAckDangerousActionMarker[] = [];
  const addMarker = (actionType: OwnerAckDangerousActionType, detail: string | null) => {
    if (markers.some((marker) => marker.actionType === actionType && marker.source === "issue_text")) return;
    markers.push({ actionType, source: "issue_text", sourceId: null, detail });
  };

  const dangerousActionMatch = text.match(/(?:^|\n)\s*(?:[-*]\s*)?(?:dangerous action|owner ack action|ack action)\s*[:\-]\s*([^\n]+)/i);
  const explicitAction = normalizeActionType(dangerousActionMatch?.[1]);
  if (explicitAction) addMarker(explicitAction, compactLine(dangerousActionMatch?.[0]));

  const deployImpactMatch = text.match(/(?:^|\n)\s*(?:[-*]\s*)?(?:deploy impact|deployment impact|deploy target)\s*[:\-]\s*([^\n]*)/i);
  if (deployImpactMatch && shouldAddBooleanStyleMarker(deployImpactMatch[1])) {
    addMarker("deploy", compactLine(deployImpactMatch[0]));
  }

  const schemaMigrationMatch = text.match(/(?:^|\n)\s*(?:[-*]\s*)?(?:schema migration|database migration|db migration)\s*[:\-]\s*([^\n]*)/i);
  if (schemaMigrationMatch && shouldAddBooleanStyleMarker(schemaMigrationMatch[1])) {
    addMarker("schema_migration", compactLine(schemaMigrationMatch[0]));
  }

  const externalCapabilityMatch = text.match(/(?:^|\n)\s*(?:[-*]\s*)?(?:external capability|shared auth|unrestricted network|sandbox bypass|approval bypass)\s*[:\-]\s*([^\n]*)/i);
  if (externalCapabilityMatch && shouldAddBooleanStyleMarker(externalCapabilityMatch[1])) {
    addMarker("external_capability", compactLine(externalCapabilityMatch[0]));
  }

  return markers;
}

function extractWorkProductMarkers(row: WorkProductRow): OwnerAckDangerousActionMarker[] {
  const metadata = (row.metadata as Record<string, unknown> | null) ?? {};
  const markers: OwnerAckDangerousActionMarker[] = [];
  const actionType =
    normalizeActionType(metadata.dangerousActionType) ??
    normalizeActionType(metadata.dangerousAction) ??
    normalizeActionType(metadata.ownerAckAction);

  if (actionType) {
    markers.push({
      actionType,
      source: "work_product_metadata",
      sourceId: row.id,
      detail: compactLine(row.title),
    });
  }

  if (truthy(metadata.requiresOwnerAck) || truthy(metadata.ackRequired)) {
    const inferred = actionType ?? normalizeActionType(metadata.deployImpact) ?? (row.type === "artifact" ? "deploy" : null);
    if (inferred && !markers.some((marker) => marker.actionType === inferred)) {
      markers.push({
        actionType: inferred,
        source: "work_product_metadata",
        sourceId: row.id,
        detail: compactLine(row.title),
      });
    }
  }

  if (
    typeof metadata.deployImpact === "string"
    && shouldAddBooleanStyleMarker(metadata.deployImpact)
    && normalizeActionType(metadata.deployImpact) === null
  ) {
    markers.push({
      actionType: "deploy",
      source: "work_product_metadata",
      sourceId: row.id,
      detail: compactLine(String(metadata.deployImpact)),
    });
  }

  return markers;
}

function missingAckFields(payload: Record<string, unknown>) {
  const missing: string[] = [];
  if (!firstString(payload, ["exactAckPhrase", "ackPhrase", "requiredAckPhrase"])) missing.push("exactAckPhrase");
  if (!firstString(payload, ["expiresAt", "expiry", "expires"])) missing.push("expiresAt");
  if (!firstString(payload, ["planHash", "stablePlanHash"]) && !firstString(payload, ["planText", "plan", "stablePlanText"])) {
    missing.push("planHashOrStablePlanText");
  }
  if (!firstString(payload, ["blastRadius", "blast_radius"])) missing.push("blastRadius");
  if (!firstString(payload, ["rollback", "rollbackPlan", "rollbackOwner"])) missing.push("rollback");
  if (!firstString(payload, ["riskCost", "riskAndCost", "risk", "cost"])) missing.push("riskCost");
  return missing;
}

function mapApproval(row: LinkedApprovalRow, now: Date): OwnerAckApprovalSummary {
  const payload = row.payload ?? {};
  const expiresAt = firstString(payload, ["expiresAt", "expiry", "expires"]);
  const expired = expiresAt ? Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) <= now.getTime() : false;
  const missingFields = missingAckFields(payload);
  if (expired) missingFields.push("unexpired");
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    decidedByUserId: row.decidedByUserId,
    decidedAt: row.decidedAt,
    expiresAt,
    exactAckPhrase: firstString(payload, ["exactAckPhrase", "ackPhrase", "requiredAckPhrase"]),
    planHash: firstString(payload, ["planHash", "stablePlanHash"]),
    hasStablePlanText: Boolean(firstString(payload, ["planText", "plan", "stablePlanText"])),
    missingFields,
    payload,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function approvalMatchesDangerousAction(
  approval: OwnerAckApprovalSummary,
  dangerousActions: OwnerAckDangerousActionMarker[],
) {
  const approvalAction = normalizeActionType(approval.payload.actionType)
    ?? normalizeActionType(approval.payload.dangerousActionType)
    ?? normalizeActionType(approval.payload.dangerousAction)
    ?? normalizeActionType(approval.payload.ownerAckAction);
  return !approvalAction || dangerousActions.some((marker) => marker.actionType === approvalAction);
}

function classifyIssue(input: {
  approvals: OwnerAckApprovalSummary[];
  dangerousActions: OwnerAckDangerousActionMarker[];
}): { status: OwnerAckAuditStatus; reasons: string[] } {
  const relevant = input.approvals.filter((approval) => approvalMatchesDangerousAction(approval, input.dangerousActions));
  const reasons: string[] = [];
  if (relevant.length === 0) return { status: "missing_ack", reasons: ["missing_linked_owner_ack_approval"] };

  const approved = relevant.filter((approval) => approval.status === "approved");
  if (approved.some((approval) => approval.missingFields.length === 0)) {
    return { status: "covered", reasons: ["has_valid_owner_ack"] };
  }

  if (relevant.some((approval) => approval.status === "pending" || approval.status === "revision_requested")) {
    reasons.push("owner_ack_pending");
    return { status: "pending_ack", reasons };
  }

  if (approved.some((approval) => approval.missingFields.includes("unexpired"))) {
    reasons.push("owner_ack_expired");
    return { status: "expired_ack", reasons };
  }

  reasons.push("owner_ack_incomplete");
  return { status: "incomplete_ack", reasons };
}

export function ownerAckAuditService(db: Db) {
  async function auditCompany(companyId: string, now = new Date()): Promise<OwnerAckAuditReport> {
    const issueRows = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), isNull(issues.hiddenAt)))
      .orderBy(desc(issues.updatedAt), desc(issues.createdAt));
    const issueIds = issueRows.map((issue) => issue.id);

    const [workProductRows, approvalRows] = await Promise.all([
      issueIds.length > 0
        ? db
            .select()
            .from(issueWorkProducts)
            .where(and(eq(issueWorkProducts.companyId, companyId), inArray(issueWorkProducts.issueId, issueIds)))
        : Promise.resolve([] as WorkProductRow[]),
      issueIds.length > 0
        ? db
            .select({
              issueId: issueApprovals.issueId,
              id: approvals.id,
              type: approvals.type,
              status: approvals.status,
              payload: approvals.payload,
              decisionNote: approvals.decisionNote,
              decidedByUserId: approvals.decidedByUserId,
              decidedAt: approvals.decidedAt,
              createdAt: approvals.createdAt,
              updatedAt: approvals.updatedAt,
            })
            .from(issueApprovals)
            .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
            .where(
              and(
                eq(issueApprovals.companyId, companyId),
                inArray(issueApprovals.issueId, issueIds),
                eq(approvals.type, "request_board_approval"),
              ),
            )
            .orderBy(desc(approvals.updatedAt), desc(approvals.createdAt))
        : Promise.resolve([] as LinkedApprovalRow[]),
    ]);

    const workProductsByIssueId = new Map<string, WorkProductRow[]>();
    for (const row of workProductRows) {
      const current = workProductsByIssueId.get(row.issueId) ?? [];
      current.push(row);
      workProductsByIssueId.set(row.issueId, current);
    }

    const approvalsByIssueId = new Map<string, OwnerAckApprovalSummary[]>();
    for (const row of approvalRows) {
      const current = approvalsByIssueId.get(row.issueId) ?? [];
      current.push(mapApproval(row, now));
      approvalsByIssueId.set(row.issueId, current);
    }

    const reportIssues: OwnerAckAuditIssue[] = [];
    for (const issue of issueRows) {
      const dangerousActions = [
        ...extractIssueTextMarkers(issue),
        ...(workProductsByIssueId.get(issue.id) ?? []).flatMap(extractWorkProductMarkers),
      ];
      if (dangerousActions.length === 0) continue;

      const approvalsForIssue = approvalsByIssueId.get(issue.id) ?? [];
      const classification = classifyIssue({ approvals: approvalsForIssue, dangerousActions });
      reportIssues.push({
        issue: {
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          status: issue.status,
          assigneeAgentId: issue.assigneeAgentId,
          assigneeUserId: issue.assigneeUserId,
          projectId: issue.projectId,
          updatedAt: issue.updatedAt,
        },
        dangerousActions,
        approvals: approvalsForIssue,
        auditStatus: classification.status,
        reasons: classification.reasons,
        observeGate: evaluateOwnerAckGate({
          mode: "observe",
          actorType: "agent",
          auditStatus: classification.status,
          reasons: classification.reasons,
        }),
      });
    }

    const summary: OwnerAckAuditReport["summary"] = {
      totalMarkedIssues: reportIssues.length,
      covered: 0,
      missingAck: 0,
      pendingAck: 0,
      expiredAck: 0,
      incompleteAck: 0,
      byActionType: {
        deploy: 0,
        schema_migration: 0,
        external_capability: 0,
      },
    };

    for (const row of reportIssues) {
      if (row.auditStatus === "covered") summary.covered += 1;
      if (row.auditStatus === "missing_ack") summary.missingAck += 1;
      if (row.auditStatus === "pending_ack") summary.pendingAck += 1;
      if (row.auditStatus === "expired_ack") summary.expiredAck += 1;
      if (row.auditStatus === "incomplete_ack") summary.incompleteAck += 1;
      for (const actionType of ACTION_TYPES) {
        if (row.dangerousActions.some((marker) => marker.actionType === actionType)) {
          summary.byActionType[actionType] += 1;
        }
      }
    }

    return {
      companyId,
      generatedAt: now.toISOString(),
      mode: "read_only",
      summary,
      issues: reportIssues,
    };
  }

  return { auditCompany };
}
