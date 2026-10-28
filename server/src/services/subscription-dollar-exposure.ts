import { heartbeatRuns, runUsageReceipts } from "@paperclipai/db";
import { sql, type SQL } from "drizzle-orm";

/** Missing final usage remains accounting debt, but verified included usage
 * carries no unresolved dollar charge. OFFSET fences keep receipt verification
 * correlated to this run instead of hashing unrelated journal history. */
export function verifiedSubscriptionIncludedRun(): SQL<boolean> {
  const usage = heartbeatRuns.usageJson;
  const envelope = runUsageReceipts.receiptJson;
  return sql<boolean>`coalesce(${usage}->>'billingType' = 'subscription_included'
    and (not (${usage} ? 'accountingCaptureFailed') or ${usage}->'accountingCaptureFailed' = 'false'::jsonb)
    and exists (select 1 from ${runUsageReceipts}
      where ${runUsageReceipts.companyId} = ${heartbeatRuns.companyId}
        and ${runUsageReceipts.runId} = ${heartbeatRuns.id}
        and ${runUsageReceipts.id}::text = ${usage}->>'accountingReceiptId'
        and ${runUsageReceipts.sourceId}::text = ${usage}->>'accountingReceiptSourceId'
        and ${runUsageReceipts.sequence}::text = ${usage}->>'accountingReceiptSequence'
        and ${envelope}->'receipt'->>'billingType' in ('subscription_included', 'subscription') offset 0)
    and not exists (select 1 from ${runUsageReceipts}
      where ${runUsageReceipts.companyId} = ${heartbeatRuns.companyId}
        and ${runUsageReceipts.runId} = ${heartbeatRuns.id}
        and (coalesce(${envelope}->'receipt'->>'billingType', 'unknown') not in ('subscription_included', 'subscription')
          or (${envelope}->>'liveCostCents' is not null
            and ${envelope}->>'liveCostCents' !~ '^0+([.]0+)?$')) offset 0), false)`;
}
