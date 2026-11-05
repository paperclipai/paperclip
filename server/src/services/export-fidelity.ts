import { and, count, eq, sql } from "drizzle-orm";
import {
  EXPORT_FIDELITY_REPORT_SCHEMA,
  buildExportFidelityWarnings,
  type ExportFidelityCounts,
  type ExportFidelityReport,
} from "@paperclipai/shared/portability-fidelity";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  approvals,
  costEvents,
  issueAttachments,
  issueDocuments,
  issueLabels,
  issueRelations,
  issueWorkProducts,
  issues,
  labels,
} from "@paperclipai/db";

export async function collectExportFidelityCounts(db: Db, companyId: string): Promise<ExportFidelityCounts> {
  const [
    labelDefinitions,
    issueLabelReferences,
    issueBlockerRelations,
    issueDocumentCount,
    issueWorkProductCount,
    issueAttachmentCount,
    approvalCount,
    costEventCount,
    activityLogEntries,
    issueMonitors,
  ] = await Promise.all([
    db.select({ count: count() }).from(labels).where(eq(labels.companyId, companyId)).then(firstCount),
    db.select({ count: count() }).from(issueLabels).where(eq(issueLabels.companyId, companyId)).then(firstCount),
    db
      .select({ count: count() })
      .from(issueRelations)
      .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.type, "blocks")))
      .then(firstCount),
    db.select({ count: count() }).from(issueDocuments).where(eq(issueDocuments.companyId, companyId)).then(firstCount),
    db.select({ count: count() }).from(issueWorkProducts).where(eq(issueWorkProducts.companyId, companyId)).then(firstCount),
    db.select({ count: count() }).from(issueAttachments).where(eq(issueAttachments.companyId, companyId)).then(firstCount),
    db.select({ count: count() }).from(approvals).where(eq(approvals.companyId, companyId)).then(firstCount),
    db.select({ count: count() }).from(costEvents).where(eq(costEvents.companyId, companyId)).then(firstCount),
    db.select({ count: count() }).from(activityLog).where(eq(activityLog.companyId, companyId)).then(firstCount),
    db
      .select({ count: count() })
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        sql`(${issues.monitorNextCheckAt} is not null or ${issues.monitorScheduledBy} is not null)`,
      ))
      .then(firstCount),
  ]);
  return {
    labelDefinitions,
    issueLabelReferences,
    issueBlockerRelations,
    issueDocuments: issueDocumentCount,
    issueWorkProducts: issueWorkProductCount,
    issueAttachments: issueAttachmentCount,
    approvals: approvalCount,
    costEvents: costEventCount,
    activityLogEntries,
    issueMonitors,
  };
}

export function buildExportFidelityReport(companyId: string, counts: ExportFidelityCounts): ExportFidelityReport {
  return {
    schema: EXPORT_FIDELITY_REPORT_SCHEMA,
    companyId,
    counts,
    warnings: buildExportFidelityWarnings(counts),
    generatedAt: new Date().toISOString(),
  };
}

function firstCount(rows: Array<{ count: number }>): number {
  return rows[0]?.count ?? 0;
}
