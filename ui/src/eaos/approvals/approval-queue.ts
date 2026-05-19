// Pure helpers behind the LET-484 `/eaos/approvals` zone. Keep DOM-free so
// the bucketing/sorting math is unit-testable without react-query mocking.
//
// Source of truth: `approvalsApi.list(companyId)` returns the canonical
// `Approval[]` shape. This module groups by status into the three operator
// buckets used on the EAOS surface:
//   - pending → needs a board / CEO / reviewer decision now.
//   - revision_requested → the approver asked for changes; ball is in the
//     requester's court.
//   - decided → already approved / rejected / cancelled.
//
// The page renders read-only — Approve / Reject / Request revision controls
// stay inside the kernel Approvals detail page until the EAOS shell gets a
// dedicated decision flow approved by the board.

import type { Approval, ApprovalStatus, ApprovalType } from "@paperclipai/shared";

export interface ApprovalQueueRow {
  readonly id: string;
  readonly status: ApprovalStatus;
  readonly typeLabel: string;
  readonly type: ApprovalType;
  readonly summary: string;
  readonly requestedAt: Date;
  readonly decidedAt: Date | null;
  readonly decisionNote: string | null;
  readonly riskLevel: "low" | "medium" | "high" | "critical";
  readonly kernelRoute: string;
}

export interface ApprovalQueueCounts {
  readonly total: number;
  readonly pending: number;
  readonly revisionRequested: number;
  readonly approved: number;
  readonly rejected: number;
  readonly cancelled: number;
  readonly highRisk: number;
}

export interface ApprovalQueueBucket {
  readonly id: "pending" | "revision_requested" | "decided";
  readonly label: string;
  readonly rows: readonly ApprovalQueueRow[];
}

const TYPE_LABELS: Record<ApprovalType, string> = {
  hire_agent: "Hire agent",
  approve_ceo_strategy: "Approve CEO strategy",
  budget_override_required: "Budget override",
  request_board_approval: "Board approval requested",
};

// LET-187 risk-tier vocabulary maps approval types to a coarse risk tier so
// the operator can scan the queue without reading the payload. This is the
// same tiering the kernel approvals tab uses; treat it as a UI hint, never
// as a gating rule.
const TYPE_RISK: Record<ApprovalType, ApprovalQueueRow["riskLevel"]> = {
  hire_agent: "medium",
  approve_ceo_strategy: "high",
  budget_override_required: "high",
  request_board_approval: "critical",
};

function pickString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function summarizePayload(approval: Approval): string {
  const payload = approval.payload ?? {};
  const reason =
    pickString(payload, "reason")
    ?? pickString(payload, "summary")
    ?? pickString(payload, "title")
    ?? pickString(payload, "description");
  if (reason) return reason;
  // Type-specific fallbacks so the row never collapses to "No summary" when
  // the payload has a useful identifier.
  switch (approval.type) {
    case "hire_agent": {
      const candidate = pickString(payload, "candidateName") ?? pickString(payload, "agentName");
      return candidate ? `Hire ${candidate}` : "Hire agent request";
    }
    case "budget_override_required": {
      const cap = pickString(payload, "capUsd") ?? pickString(payload, "limitUsd");
      return cap ? `Budget override · ${cap}` : "Budget override request";
    }
    case "approve_ceo_strategy":
      return pickString(payload, "strategyTitle") ?? "CEO strategy approval";
    case "request_board_approval":
      return pickString(payload, "topic") ?? "Board approval requested";
    default:
      return "Approval request";
  }
}

export function buildApprovalQueueRow(approval: Approval): ApprovalQueueRow {
  const requested = approval.createdAt instanceof Date ? approval.createdAt : new Date(approval.createdAt as unknown as string);
  const decided = approval.decidedAt
    ? approval.decidedAt instanceof Date
      ? approval.decidedAt
      : new Date(approval.decidedAt as unknown as string)
    : null;
  return {
    id: approval.id,
    status: approval.status,
    typeLabel: TYPE_LABELS[approval.type] ?? approval.type,
    type: approval.type,
    summary: summarizePayload(approval),
    requestedAt: requested,
    decidedAt: decided,
    decisionNote: approval.decisionNote,
    riskLevel: TYPE_RISK[approval.type] ?? "medium",
    kernelRoute: `/approvals/${approval.id}`,
  };
}

export function summarizeApprovals(approvals: readonly Approval[]): ApprovalQueueCounts {
  let pending = 0;
  let revisionRequested = 0;
  let approved = 0;
  let rejected = 0;
  let cancelled = 0;
  let highRisk = 0;
  for (const approval of approvals) {
    switch (approval.status) {
      case "pending":
        pending += 1;
        break;
      case "revision_requested":
        revisionRequested += 1;
        break;
      case "approved":
        approved += 1;
        break;
      case "rejected":
        rejected += 1;
        break;
      case "cancelled":
        cancelled += 1;
        break;
    }
    const tier = TYPE_RISK[approval.type] ?? "medium";
    if ((tier === "high" || tier === "critical") && (approval.status === "pending" || approval.status === "revision_requested")) {
      highRisk += 1;
    }
  }
  return {
    total: approvals.length,
    pending,
    revisionRequested,
    approved,
    rejected,
    cancelled,
    highRisk,
  };
}

export function groupApprovalsForQueue(
  approvals: readonly Approval[],
): readonly ApprovalQueueBucket[] {
  const rows = approvals.map(buildApprovalQueueRow);
  const pending = rows.filter((row) => row.status === "pending");
  const revisionRequested = rows.filter((row) => row.status === "revision_requested");
  const decided = rows.filter(
    (row) => row.status === "approved" || row.status === "rejected" || row.status === "cancelled",
  );
  // Pending sorts oldest-first (longest-waiting at top); revision_requested
  // also oldest-first (those have been waiting); decided sorts most-recent.
  pending.sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime());
  revisionRequested.sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime());
  decided.sort((a, b) => {
    const aMs = (a.decidedAt ?? a.requestedAt).getTime();
    const bMs = (b.decidedAt ?? b.requestedAt).getTime();
    return bMs - aMs;
  });
  return [
    { id: "pending", label: "Pending decision", rows: pending },
    { id: "revision_requested", label: "Awaiting revision", rows: revisionRequested },
    { id: "decided", label: "Recently decided", rows: decided.slice(0, 10) },
  ];
}

export const APPROVAL_QUEUE_TEST_HELPERS = {
  TYPE_RISK,
  TYPE_LABELS,
};
