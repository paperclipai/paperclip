export type PortabilityFidelitySeverity = "info" | "warning" | "blocker";

export interface PortabilityFidelityWarning {
  code: string;
  severity: PortabilityFidelitySeverity;
  message: string;
}

export const EXPORT_FIDELITY_REPORT_SCHEMA = "paperclip-export-fidelity-v1";

export const EXPORT_FIDELITY_COUNT_KEYS = [
  "labelDefinitions",
  "issueLabelReferences",
  "issueBlockerRelations",
  "issueDocuments",
  "issueWorkProducts",
  "issueAttachments",
  "approvals",
  "costEvents",
  "activityLogEntries",
  "issueMonitors",
] as const;

export type ExportFidelityCounts = Record<(typeof EXPORT_FIDELITY_COUNT_KEYS)[number], number>;

export interface ExportFidelityReport {
  schema: typeof EXPORT_FIDELITY_REPORT_SCHEMA;
  companyId: string;
  counts: ExportFidelityCounts;
  warnings: PortabilityFidelityWarning[];
  generatedAt: string;
}

const UNSUPPORTED_DATA_WARNINGS: ReadonlyArray<[code: string, countKey: keyof ExportFidelityCounts, label: string]> = [
  ["issue_blockers_not_exported", "issueBlockerRelations", "issue blocker relation"],
  ["issue_documents_not_exported", "issueDocuments", "issue document"],
  ["work_products_not_exported", "issueWorkProducts", "issue work product"],
  ["attachments_not_exported", "issueAttachments", "issue attachment"],
  ["approvals_not_exported", "approvals", "approval"],
  ["cost_history_not_exported", "costEvents", "cost event"],
  ["activity_history_not_exported", "activityLogEntries", "activity log entry"],
  ["monitors_not_exported", "issueMonitors", "issue monitor"],
];

export function buildExportFidelityWarnings(counts: ExportFidelityCounts): PortabilityFidelityWarning[] {
  const warnings: PortabilityFidelityWarning[] = [];
  if (counts.issueLabelReferences > 0) {
    warnings.push({
      code: "labels_require_mapping",
      severity: "blocker",
      message:
        `Importing this export will fail because ${counts.issueLabelReferences} issue label ` +
        `${counts.issueLabelReferences === 1 ? "reference refers" : "references refer"} to label ` +
        "definitions that are not included in the export bundle.",
    });
  } else if (counts.labelDefinitions > 0) {
    warnings.push({
      code: "label_definitions_not_exported",
      severity: "warning",
      message:
        `${counts.labelDefinitions} label definition${counts.labelDefinitions === 1 ? " is" : "s are"} ` +
        "not included in the export bundle.",
    });
  }
  for (const [code, countKey, label] of UNSUPPORTED_DATA_WARNINGS) {
    const rowCount = counts[countKey];
    if (rowCount <= 0) continue;
    warnings.push({
      code,
      severity: "warning",
      message: `${rowCount} ${label}${rowCount === 1 ? " is" : "s are"} not included in the export bundle.`,
    });
  }
  return warnings;
}

export function normalizeExportFidelityCounts(value: unknown): ExportFidelityCounts | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const counts = {} as Record<(typeof EXPORT_FIDELITY_COUNT_KEYS)[number], number>;
  for (const key of EXPORT_FIDELITY_COUNT_KEYS) {
    const raw = record[key];
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
    counts[key] = raw;
  }
  return counts;
}
