import type { DurableWakeAdmissionReceipt } from "./ports.js";
import { readNonEmptyString } from "../domain/values.js";

type WakeReceiptSeed = {
  agentId: string;
  source: string;
  triggerDetail: string | null;
  reason: string | null;
  payload: Record<string, unknown> | null;
  requestedByActorType: string | null;
  requestedByActorId: string | null;
  idempotencyKey: string | null;
};

type QueuedRunSeed = {
  id?: string;
  agentId: string;
  scopeKind: "issue" | "company";
  issueId: string | null;
  invocationSource: string;
  triggerDetail: string | null;
  responsibleUserId: string;
  wakeupRequestId: string;
  retryOfRunId: string | null;
  contextSnapshot: Record<string, unknown>;
  sessionIdBefore: string | null;
  continuationAttempt: number;
  scheduledRetryAttempt?: number;
  scheduledRetryReason?: "transient_failure";
};

type SaveWakeReceipt =
  | { kind: "insert"; seed: WakeReceiptSeed & Partial<DurableWakeAdmissionReceipt> }
  | { kind: "promote"; wakeId: string; agentId: string; payload: WakeReceiptSeed["payload"] };

export type FreshIssueRunWriter<Run> = {
  saveReceipt(input: SaveWakeReceipt): Promise<{ id: string } | undefined>;
  insertQueuedRun(seed: QueuedRunSeed): Promise<Run>;
  bindReceipts(input: {
    wakeId: string;
    runId: string;
    failedChatRetryReceiptId?: string;
    adopted?: { wakeIds: string[]; payload: Record<string, unknown> };
  }): Promise<void>;
};

/**
 * Runs under heartbeat's existing issue lock. The caller validates admission,
 * selects saved comments and records specialized continuation delivery between
 * run creation and receipt binding.
 */
export function createFreshIssueRunAdmission<Run>(writer: FreshIssueRunWriter<Run>) {
  return {
    createReceipt(input: WakeReceiptSeed & {
      durableReceipt?: DurableWakeAdmissionReceipt;
      deferredChatReceiptId?: string;
    }) {
      const { durableReceipt, deferredChatReceiptId, ...seed } = input;
      // A deferred durable chat wake keeps its original identity and source.
      return writer.saveReceipt(deferredChatReceiptId
        ? { kind: "promote", wakeId: deferredChatReceiptId, agentId: seed.agentId, payload: seed.payload }
        : {
            kind: "insert",
            seed: durableReceipt
              ? { ...seed, id: durableReceipt.id, requestedAt: durableReceipt.requestedAt }
              : seed,
          });
    },
    createRun(input: Omit<QueuedRunSeed,
      "id" | "scopeKind" | "issueId" | "scheduledRetryAttempt" | "scheduledRetryReason"
    > & {
      explicitContinuationRunId: string | null;
      reconciledSourceRunId: string | null;
      reconciledRestoreRetryCount: number | null;
      issueId: unknown;
    }) {
      const {
        explicitContinuationRunId, reconciledSourceRunId, reconciledRestoreRetryCount, issueId, ...seed
      } = input;
      const scopedIssueId = readNonEmptyString(issueId);
      return writer.insertQueuedRun({
        ...seed,
        ...(explicitContinuationRunId ? { id: explicitContinuationRunId } : {}),
        scopeKind: scopedIssueId ? "issue" : "company",
        issueId: scopedIssueId,
        retryOfRunId: reconciledSourceRunId || seed.retryOfRunId,
        sessionIdBefore: explicitContinuationRunId ? null : seed.sessionIdBefore,
        ...(reconciledRestoreRetryCount !== null ? {
          scheduledRetryAttempt: reconciledRestoreRetryCount,
          scheduledRetryReason: "transient_failure",
        } : {}),
      });
    },
    bindReceipts: writer.bindReceipts,
  };
}
