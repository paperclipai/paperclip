import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueDeliveryReceipts, issueRecoveryActions, issues } from "@paperclipai/db";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTransaction = Db | DbTransaction;

export type DeliveryReceiptInput = {
  sourceIssueId?: string;
  primaryWorkProductKey: string;
  revision: string;
  format: "inline_text" | "work_product" | "document" | "url";
  summary: string;
  inlineText?: string;
  inspectionUrl?: string;
  documentOnly?: boolean;
  metadata?: Record<string, unknown>;
};

export type ReceiptPublication = { id: string; sourceIssueId: string; reused: boolean };

/**
 * Receipts are deliberately keyed by requester-facing source + product + revision.
 * A child may only project to its direct parent; authorization of that parent is
 * checked by the route before this service is invoked.
 */
export function issueDeliveryReceiptService(db: Db) {
  async function publish(
    tx: DbOrTransaction,
    input: { companyId: string; producerIssueId: string; sourceIssueId: string; createdByRunId?: string | null; receipt: DeliveryReceiptInput },
  ): Promise<ReceiptPublication> {
    const existing = await tx.select({ id: issueDeliveryReceipts.id }).from(issueDeliveryReceipts).where(and(
      eq(issueDeliveryReceipts.companyId, input.companyId),
      eq(issueDeliveryReceipts.sourceIssueId, input.sourceIssueId),
      eq(issueDeliveryReceipts.primaryWorkProductKey, input.receipt.primaryWorkProductKey),
      eq(issueDeliveryReceipts.revision, input.receipt.revision),
    )).then((rows) => rows[0] ?? null);
    if (existing) return { id: existing.id, sourceIssueId: input.sourceIssueId, reused: true };

    const created = await tx.insert(issueDeliveryReceipts).values({
      companyId: input.companyId,
      sourceIssueId: input.sourceIssueId,
      producerIssueId: input.producerIssueId,
      primaryWorkProductKey: input.receipt.primaryWorkProductKey,
      revision: input.receipt.revision,
      format: input.receipt.format,
      summary: input.receipt.summary,
      inlineText: input.receipt.inlineText ?? null,
      inspectionUrl: input.receipt.inspectionUrl ?? null,
      documentOnly: input.receipt.documentOnly ?? false,
      metadata: input.receipt.metadata ?? {},
      createdByRunId: input.createdByRunId ?? null,
    }).returning({ id: issueDeliveryReceipts.id }).then((rows) => rows[0]);
    return { id: created!.id, sourceIssueId: input.sourceIssueId, reused: false };
  }

  async function hasReceipt(companyId: string, sourceIssueId: string) {
    return Boolean(await db.select({ id: issueDeliveryReceipts.id }).from(issueDeliveryReceipts).where(and(
      eq(issueDeliveryReceipts.companyId, companyId), eq(issueDeliveryReceipts.sourceIssueId, sourceIssueId),
    )).limit(1).then((rows) => rows[0]));
  }

  /** Atomically consumes the one allowed missing-receipt recovery attempt. */
  async function openMissingReceiptRecovery(input: { companyId: string; sourceIssueId: string; ownerAgentId?: string | null }) {
    return db.transaction(async (tx) => {
      const claimed = await tx.update(issues).set({ deliveryReceiptRecoveryOpenedAt: new Date(), updatedAt: new Date() }).where(and(
        eq(issues.id, input.sourceIssueId), eq(issues.companyId, input.companyId), isNull(issues.deliveryReceiptRecoveryOpenedAt),
      )).returning({ id: issues.id });
      if (!claimed[0]) return false;
      await tx.insert(issueRecoveryActions).values({
        companyId: input.companyId,
        sourceIssueId: input.sourceIssueId,
        kind: "missing_disposition",
        status: "active",
        ownerType: input.ownerAgentId ? "agent" : "board",
        ownerAgentId: input.ownerAgentId ?? null,
        cause: "missing_delivery_receipt",
        fingerprint: "missing_delivery_receipt:v1",
        evidence: { source: "terminal_transition" },
        nextAction: "Publish a requester-visible delivery receipt before requesting terminal or review status.",
        maxAttempts: 1,
        attemptCount: 1,
        lastAttemptAt: new Date(),
      });
      return true;
    });
  }

  return { publish, hasReceipt, openMissingReceiptRecovery };
}
