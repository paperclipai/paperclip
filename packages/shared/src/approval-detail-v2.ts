import {
  APPROVAL_STATUSES,
  APPROVAL_TYPES,
  type ApprovalStatus,
  type ApprovalType,
} from "./constants.js";
import type {
  ApprovalDetailV2,
  ApprovalRefundDetail,
  ApprovalReplyDetail,
  ApprovalSideEffect,
} from "./types/approval.js";

/** Contract version emitted by {@link hydrateApprovalDetailV2}. */
export const APPROVAL_DETAIL_CONTRACT_VERSION = 2 as const;

/**
 * Minimal shape the hydrator needs. Matches the persisted `Approval` record but
 * is stated structurally so callers can pass an already-redacted view without a
 * dependency on the server redaction layer.
 */
export interface HydratableApproval {
  id: string;
  companyId: string;
  // Persisted rows type these columns as plain strings; the hydrator accepts
  // that and narrows to the enum on the output envelope.
  type: ApprovalType | string;
  status: ApprovalStatus | string;
  requestedByAgentId: string | null;
  requestedByUserId: string | null;
  payload: Record<string, unknown>;
  decisionNote: string | null;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface HydrateApprovalDetailOptions {
  /**
   * When true, attach the raw `payload` to the envelope. Callers are expected
   * to pass an already-redacted approval, so the attached payload carries no
   * unredacted material. Omitted by default.
   */
  includePayload?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Build a lookup that reads a key from the top level or, failing that, from any
 * of the named nested container objects. Top-level keys win.
 */
function withContainers(
  payload: Record<string, unknown>,
  containerKeys: string[],
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const key of containerKeys) {
    const nested = payload[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      Object.assign(merged, nested as Record<string, unknown>);
    }
  }
  // Top-level fields take precedence over nested container fields.
  return { ...merged, ...payload };
}

function readString(
  source: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function readNumber(
  source: Record<string, unknown>,
  keys: string[],
): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value.replace(/[$,\s]/g, ""));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function readStringArray(
  source: Record<string, unknown>,
  keys: string[],
): string[] {
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) {
      const items = value
        .map((entry) => {
          if (typeof entry === "string") return entry.trim();
          const record = asRecord(entry);
          return readString(record, ["name", "title", "sku", "label"]);
        })
        .filter((entry): entry is string => Boolean(entry && entry.length > 0));
      if (items.length > 0) return items;
    }
  }
  return [];
}

const REFUND_SIGNAL_KEYS = [
  "refund",
  "refundAmount",
  "refund_amount",
  "refundTotal",
  "refundDetails",
  "refundRequest",
];

const REPLY_SIGNAL_KEYS = [
  "reply",
  "proposedMessage",
  "proposedReply",
  "replyBody",
  "originalMessage",
  "incomingMessage",
];

/** Container keys whose nested object can hold a full reply/email payload. */
const REPLY_CONTAINER_KEYS = ["reply", "email", "message", "draft"];

/**
 * True when at least one of `containerKeys` maps to a nested object on the
 * top-level payload. A scalar value under the same key (for example a bare
 * requester `email` string) does not count, so this does not mis-read a
 * non-reply payload as a reply.
 */
function hasNestedContainer(
  payload: Record<string, unknown>,
  containerKeys: string[],
): boolean {
  return containerKeys.some((key) => {
    const value = payload[key];
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  });
}

/** Read `action`/`type`/`kind`/`gate`-style discriminator fields as one blob. */
function actionSignal(payload: Record<string, unknown>): string {
  return readString(payload, [
    "action",
    "actionType",
    "kind",
    "gate",
    "recommendedAction",
    "decision",
    "intent",
  ])?.toLowerCase() ?? "";
}

function extractRefund(
  payload: Record<string, unknown>,
): ApprovalRefundDetail | null {
  const source = withContainers(payload, ["refund", "refundDetails", "refundRequest"]);
  const orderId = readString(source, [
    "orderId",
    "order_id",
    "orderNumber",
    "order_number",
    "wooOrderId",
    "order",
  ]);
  const amount = readNumber(source, [
    "refundAmount",
    "refund_amount",
    "amount",
    "refundTotal",
    "total",
  ]);
  const currency = readString(source, ["currency", "currencyCode", "currency_code"]);
  const reason = readString(source, ["reason", "refundReason", "note", "justification"]);
  const lineItems = readStringArray(source, ["lineItems", "line_items", "items"]);

  const hasRefundSignal =
    REFUND_SIGNAL_KEYS.some((key) => key in payload) ||
    actionSignal(payload).includes("refund");

  // Refund-shaped requires a refund signal AND something concrete to act on,
  // so a generic board approval is never mis-read as a refund.
  if (!hasRefundSignal || (orderId === null && amount === null)) {
    return null;
  }
  return { orderId, amount, currency, reason, lineItems };
}

function extractReply(
  payload: Record<string, unknown>,
): ApprovalReplyDetail | null {
  const source = withContainers(payload, REPLY_CONTAINER_KEYS);
  const recipient = readString(source, [
    "recipient",
    "recipientEmail",
    "to",
    "toAddress",
    "customerEmail",
    "email",
  ]);
  const subject = readString(source, ["subject", "emailSubject", "title"]);
  const originalMessage = readString(source, [
    "originalMessage",
    "original",
    "incomingMessage",
    "inboundMessage",
    "customerMessage",
    "originalBody",
    "quotedMessage",
  ]);
  const proposedMessage = readString(source, [
    "proposedMessage",
    "proposedReply",
    "proposed",
    "replyBody",
    "responseBody",
    "draft",
    "body",
    "message",
    "text",
  ]);

  // Email-specific evidence: a destination address, an explicit subject, or an
  // explicit reply field. Generic prose fields (`body`/`text`/`message`/`draft`/
  // `title`) do NOT count on their own, so a non-email approval such as
  // `{ draft: { title, body } }` is not mis-read as a reply and never emits a
  // spurious `email_reply` side effect. A bare `email` scalar (a requester
  // address) is also excluded here — only true destination keys count.
  const destinationRecipient = readString(source, [
    "recipient",
    "recipientEmail",
    "to",
    "toAddress",
    "customerEmail",
  ]);
  const explicitSubject = readString(source, ["subject", "emailSubject"]);
  const explicitReplyBody = readString(source, [
    "proposedMessage",
    "proposedReply",
    "proposed",
    "replyBody",
    "responseBody",
  ]);
  const hasEmailEvidence =
    destinationRecipient !== null ||
    explicitSubject !== null ||
    originalMessage !== null ||
    explicitReplyBody !== null;

  const hasReplySignal =
    REPLY_SIGNAL_KEYS.some((key) => key in payload) ||
    (hasNestedContainer(payload, REPLY_CONTAINER_KEYS) && hasEmailEvidence) ||
    /reply|email|gate\s*b/.test(actionSignal(payload)) ||
    (recipient !== null && subject !== null);

  if (!hasReplySignal) return null;
  if (
    recipient === null &&
    subject === null &&
    originalMessage === null &&
    proposedMessage === null
  ) {
    return null;
  }
  return { recipient, subject, originalMessage, proposedMessage };
}

function formatAmount(amount: number | null, currency: string | null): string {
  if (amount === null) return "";
  const money = currency ? `${amount} ${currency}` : `${amount}`;
  return money;
}

function buildSideEffects(
  approval: HydratableApproval,
  payload: Record<string, unknown>,
  refund: ApprovalRefundDetail | null,
  reply: ApprovalReplyDetail | null,
): ApprovalSideEffect[] {
  const effects: ApprovalSideEffect[] = [];

  if (refund) {
    const money = formatAmount(refund.amount, refund.currency);
    const onOrder = refund.orderId ? ` on order ${refund.orderId}` : "";
    effects.push({
      kind: "refund",
      description: `Issue refund${money ? ` of ${money}` : ""}${onOrder}`.trim(),
      ...(refund.orderId ? { target: refund.orderId } : {}),
      ...(refund.amount !== null ? { amount: refund.amount } : {}),
      ...(refund.currency ? { currency: refund.currency } : {}),
    });
  }

  if (reply) {
    const toWhom = reply.recipient ? ` to ${reply.recipient}` : "";
    const about = reply.subject ? ` — "${reply.subject}"` : "";
    effects.push({
      kind: "email_reply",
      description: `Send reply${toWhom}${about}`,
      ...(reply.recipient ? { target: reply.recipient } : {}),
    });
  }

  if (approval.type === "hire_agent") {
    const agentName = readString(payload, [
      "agentName",
      "name",
      "role",
      "agentRole",
      "title",
    ]);
    effects.push({
      kind: "hire_agent",
      description: `Hire agent${agentName ? ` ${agentName}` : ""}`,
      ...(agentName ? { target: agentName } : {}),
    });
  }

  return effects;
}

function defaultSummaryForType(type: string): string {
  switch (type) {
    case "hire_agent":
      return "Hire agent approval";
    case "approve_ceo_strategy":
      return "CEO strategy approval";
    case "budget_override_required":
      return "Budget override approval";
    case "request_board_approval":
      return "Board approval requested";
    default:
      return "Approval";
  }
}

function buildSummary(
  approval: HydratableApproval,
  payload: Record<string, unknown>,
  refund: ApprovalRefundDetail | null,
  reply: ApprovalReplyDetail | null,
): string {
  const explicit = readString(payload, ["summary", "title", "description"]);
  if (explicit) return explicit;
  if (refund) {
    return `Refund approval${refund.orderId ? ` for order ${refund.orderId}` : ""}`;
  }
  if (reply) {
    return `Reply approval${reply.recipient ? ` to ${reply.recipient}` : ""}`;
  }
  return defaultSummaryForType(approval.type);
}

/**
 * Turn a persisted approval into the hydrated v2 detail envelope. Pure: no I/O,
 * no DB, no clock. Pass an already-redacted approval when `includePayload` is
 * requested so the attached raw payload carries no unredacted material.
 */
/**
 * Narrow a persisted free-text column to its enum, falling back to a safe
 * default when the stored value is not a known member. Persisted `type`/`status`
 * columns are plain strings, so a legacy or malformed row could otherwise emit
 * an envelope that violates the exported `approvalDetailV2Schema`.
 */
function coerceEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

export function hydrateApprovalDetailV2(
  approval: HydratableApproval,
  options: HydrateApprovalDetailOptions = {},
): ApprovalDetailV2 {
  const payload = asRecord(approval.payload);
  const refund = extractRefund(payload);
  const reply = extractReply(payload);
  const sideEffects = buildSideEffects(approval, payload, refund, reply);
  const summary = buildSummary(approval, payload, refund, reply);

  const detail: ApprovalDetailV2 = {
    version: APPROVAL_DETAIL_CONTRACT_VERSION,
    id: approval.id,
    companyId: approval.companyId,
    type: coerceEnum<ApprovalType>(approval.type, APPROVAL_TYPES, "request_board_approval"),
    // An unknown persisted status falls back to the terminal, non-actionable
    // `cancelled` — never `pending`. `pending` is actionable in the review UI,
    // but the server rejects resolving a status it does not recognize, so a
    // malformed/legacy row would otherwise show approve/reject/revision controls
    // that can never succeed. `cancelled` surfaces the row without live controls.
    status: coerceEnum<ApprovalStatus>(approval.status, APPROVAL_STATUSES, "cancelled"),
    requestedByAgentId: approval.requestedByAgentId,
    requestedByUserId: approval.requestedByUserId,
    decisionNote: approval.decisionNote,
    decidedByUserId: approval.decidedByUserId,
    decidedAt: approval.decidedAt,
    createdAt: approval.createdAt,
    updatedAt: approval.updatedAt,
    summary,
    sideEffects,
    refund,
    reply,
  };

  if (options.includePayload) {
    detail.payload = approval.payload;
  }

  return detail;
}
