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

const UNSUPPORTED_DATA_WARNINGS: ReadonlyArray<[code: string, countKey: keyof ExportFidelityCounts, singular: string, plural: string]> = [
  ["approvals_not_exported", "approvals", "approval", "approvals"],
  ["cost_history_not_exported", "costEvents", "cost event", "cost events"],
  ["activity_history_not_exported", "activityLogEntries", "activity log entry", "activity log entries"],
];

export function buildExportFidelityWarnings(counts: ExportFidelityCounts): PortabilityFidelityWarning[] {
  const warnings: PortabilityFidelityWarning[] = [];
  for (const [code, countKey, singular, plural] of UNSUPPORTED_DATA_WARNINGS) {
    const rowCount = counts[countKey];
    if (rowCount <= 0) continue;
    warnings.push({
      code,
      severity: "warning",
      message: `${rowCount} ${rowCount === 1 ? `${singular} is` : `${plural} are`} not included in the export bundle.`,
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
