import type { ApprovalStatus, ApprovalType } from "../constants.js";

export interface Approval {
  id: string;
  companyId: string;
  type: ApprovalType;
  requestedByAgentId: string | null;
  requestedByUserId: string | null;
  status: ApprovalStatus;
  payload: Record<string, unknown>;
  decisionNote: string | null;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApprovalComment {
  id: string;
  companyId: string;
  approvalId: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A single consequence that approving this card will cause. The detail view
 * renders one row per effect so a decider sees what they are authorizing
 * without reading the raw payload. Money-moving effects carry `amount` +
 * `currency`; every effect names its primary `target` when one exists.
 */
export interface ApprovalSideEffect {
  /** Stable machine kind, e.g. "refund", "email_reply", "hire_agent". */
  kind: string;
  /** One-line human-readable statement of what approving will do. */
  description: string;
  /** Primary entity the effect acts on (order id, recipient, agent name). */
  target?: string;
  /** Signed monetary amount, present only when the effect moves money. */
  amount?: number;
  /** ISO currency code paired with `amount`. */
  currency?: string;
}

/** Curated refund context, populated when the payload is refund-shaped. */
export interface ApprovalRefundDetail {
  orderId: string | null;
  amount: number | null;
  currency: string | null;
  reason: string | null;
  lineItems: string[];
}

/** Curated reply context, populated when the payload is reply-shaped. */
export interface ApprovalReplyDetail {
  recipient: string | null;
  subject: string | null;
  originalMessage: string | null;
  proposedMessage: string | null;
}

/**
 * Hydrated approval detail envelope (contract version 2). Returned from
 * `GET /api/approvals/:id?v=2`. The raw `payload` is omitted by default so the
 * detail surface never leaks unredacted material; it is attached only when the
 * caller explicitly opts in. The `version` discriminator lets existing
 * consumers of the legacy shape keep working unchanged.
 */
export interface ApprovalDetailV2 {
  version: 2;
  id: string;
  companyId: string;
  type: ApprovalType;
  status: ApprovalStatus;
  requestedByAgentId: string | null;
  requestedByUserId: string | null;
  decisionNote: string | null;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Curated one-line summary suitable for a card header. */
  summary: string;
  /** What approving will cause. Non-empty for money-moving refunds. */
  sideEffects: ApprovalSideEffect[];
  /** Populated when the payload is refund-shaped; otherwise null. */
  refund: ApprovalRefundDetail | null;
  /** Populated when the payload is reply-shaped; otherwise null. */
  reply: ApprovalReplyDetail | null;
  /** Raw (redacted) payload, omitted by default; present only on opt-in. */
  payload?: Record<string, unknown>;
}
