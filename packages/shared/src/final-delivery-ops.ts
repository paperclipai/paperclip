import type { MissionControlApprovalGate } from "./mission-control.js";
import type { IssueFinalDeliveryDestination, IssueFinalDeliveryResult } from "./validators/issue.js";
import { redactLearningEvidence } from "./learning-postmortem.js";

export type FinalDeliveryHistoryEntryStatus = "pending" | "accepted" | "resolved" | "rejected" | "cancelled";
export type FinalDeliveryHistoryOutcome = "queued" | "accepted" | "sending" | "delivered" | "failed" | "skipped" | "rejected" | "cancelled";

export interface FinalDeliveryHistoryEntryInput {
  id: string;
  createdAt: string | Date;
  updatedAt?: string | Date | null;
  status: FinalDeliveryHistoryEntryStatus;
  result?: IssueFinalDeliveryResult | null;
  artifactCount?: number;
  summary?: string | null;
}

export interface FinalDeliveryHistorySummaryEntry {
  id: string;
  createdAt: string;
  outcome: FinalDeliveryHistoryOutcome;
  retryable: boolean;
  terminal: boolean;
  attemptCount: number;
  artifactCount: number;
  error: string | null;
  externalMessageId: string | null;
}

export interface FinalDeliveryHistorySummaryInput {
  destination: IssueFinalDeliveryDestination;
  entries: FinalDeliveryHistoryEntryInput[];
}

export interface FinalDeliveryHistorySummary {
  destinationSummary: string;
  latestOutcome: FinalDeliveryHistoryOutcome | null;
  retryableCount: number;
  terminalCount: number;
  artifactCount: number;
  entries: FinalDeliveryHistorySummaryEntry[];
}

export interface FinalDeliveryOperationPlanInput {
  issueId: string;
  deliveryId: string;
  outcome: FinalDeliveryHistoryOutcome;
  retryable?: boolean;
  requestedBy: string;
  nowIso: string;
}

export interface FinalDeliveryOperationPlan {
  operation: "retry" | "cancel";
  allowed: boolean;
  reason: string;
  idempotencyKey: string;
  requiredApprovalGate: MissionControlApprovalGate;
  mutatesOutbox: boolean;
  sendsImmediately: boolean;
  requestedBy: string;
  requestedAt: string;
}

function maskValue(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const visible = trimmed.length <= 4 ? trimmed : trimmed.slice(-4);
  return `…${visible}`;
}

export function maskFinalDeliveryDestination(destination: IssueFinalDeliveryDestination): string {
  if (destination.platform === "telegram") {
    return [
      "Telegram",
      `chat ${maskValue(destination.chatId)}`,
      destination.threadId ? `thread ${maskValue(destination.threadId)}` : null,
      destination.messageId ? `message ${maskValue(destination.messageId)}` : null,
    ]
      .filter((part): part is string => Boolean(part))
      .join(" · ");
  }

  return [
    "Slack",
    `channel ${maskValue(destination.channelId)}`,
    destination.threadTs ? `thread ${maskValue(destination.threadTs)}` : null,
    destination.messageTs ? `message ${maskValue(destination.messageTs)}` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function dateMs(value: string | Date | null | undefined): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function outcomeFor(entry: FinalDeliveryHistoryEntryInput): FinalDeliveryHistoryOutcome {
  if (entry.result?.outcome) return entry.result.outcome;
  if (entry.status === "pending") return "queued";
  if (entry.status === "accepted") return "accepted";
  if (entry.status === "rejected") return "rejected";
  if (entry.status === "cancelled") return "cancelled";
  return "queued";
}

function isTerminal(outcome: FinalDeliveryHistoryOutcome, result?: IssueFinalDeliveryResult | null): boolean {
  if (typeof result?.terminal === "boolean") return result.terminal;
  return ["delivered", "skipped", "rejected", "cancelled"].includes(outcome);
}

function isRetryable(outcome: FinalDeliveryHistoryOutcome, result?: IssueFinalDeliveryResult | null): boolean {
  if (typeof result?.retryable === "boolean") return result.retryable;
  return outcome === "failed";
}

export function buildFinalDeliveryHistorySummary(input: FinalDeliveryHistorySummaryInput): FinalDeliveryHistorySummary {
  const entries = [...input.entries]
    .sort((a, b) => dateMs(b.createdAt) - dateMs(a.createdAt))
    .map((entry) => {
      const outcome = outcomeFor(entry);
      const retryable = isRetryable(outcome, entry.result);
      const terminal = isTerminal(outcome, entry.result);
      return {
        id: entry.id,
        createdAt: toIso(entry.createdAt),
        outcome,
        retryable,
        terminal,
        attemptCount: entry.result?.attemptCount ?? 0,
        artifactCount: entry.artifactCount ?? 0,
        error: entry.result?.error ? redactLearningEvidence(entry.result.error) : null,
        externalMessageId: entry.result?.externalMessageId ?? null,
      };
    });

  return {
    destinationSummary: maskFinalDeliveryDestination(input.destination),
    latestOutcome: entries[0]?.outcome ?? null,
    retryableCount: entries.filter((entry) => entry.retryable).length,
    terminalCount: entries.filter((entry) => entry.terminal).length,
    artifactCount: entries.reduce((sum, entry) => sum + entry.artifactCount, 0),
    entries,
  };
}

export function planFinalDeliveryRetry(input: FinalDeliveryOperationPlanInput): FinalDeliveryOperationPlan {
  const terminal = ["delivered", "skipped", "rejected", "cancelled"].includes(input.outcome);
  const allowed = !terminal && (input.retryable ?? input.outcome === "failed");
  return {
    operation: "retry",
    allowed,
    reason: allowed ? "Retry will requeue the delivery; worker send remains asynchronous." : terminal ? "Cannot retry a terminal final_delivery outcome." : "Delivery is not marked retryable.",
    idempotencyKey: `final-delivery:retry:${input.issueId}:${input.deliveryId}`,
    requiredApprovalGate: "lead",
    mutatesOutbox: true,
    sendsImmediately: false,
    requestedBy: input.requestedBy,
    requestedAt: input.nowIso,
  };
}

export function planFinalDeliveryCancel(input: FinalDeliveryOperationPlanInput): FinalDeliveryOperationPlan {
  const terminal = ["delivered", "skipped", "rejected", "cancelled"].includes(input.outcome);
  const allowed = !terminal;
  return {
    operation: "cancel",
    allowed,
    reason: allowed ? "Cancel will mark the pending delivery terminal without contacting the destination." : "Cannot cancel a terminal final_delivery outcome.",
    idempotencyKey: `final-delivery:cancel:${input.issueId}:${input.deliveryId}`,
    requiredApprovalGate: "lead",
    mutatesOutbox: true,
    sendsImmediately: false,
    requestedBy: input.requestedBy,
    requestedAt: input.nowIso,
  };
}
