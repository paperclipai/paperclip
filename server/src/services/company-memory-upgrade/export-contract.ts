/**
 * Importer contract definitions and timestamp parsing for export (TECH-8573).
 */

export const EXPORT_MAX_TEXT_CHARS = 2000;
export const EXPORT_MAX_METADATA_CHARS = 200;

export const EXPORT_MANIFEST_ALLOWED_KEYS = [
  "format_version",
  "company_id",
  "agent_id",
  "upgrade_id",
  "converter_id",
  "converter_version",
  "record_count",
  "skipped_counts_by_outcome",
  "jsonl_sha256",
  "created_at",
  "tool",
] as const;

export type ExportManifestKey = (typeof EXPORT_MANIFEST_ALLOWED_KEYS)[number];

const ISO_WITH_TZ_REGEX =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;

export function parseAndNormalizeUtcIsoTimestamp(val: unknown): { valid: boolean; iso: string | null } {
  if (val === null || val === undefined) {
    return { valid: true, iso: null };
  }
  if (typeof val !== "string" || !ISO_WITH_TZ_REGEX.test(val.trim())) {
    return { valid: false, iso: null };
  }
  const d = new Date(val.trim());
  if (isNaN(d.getTime())) {
    return { valid: false, iso: null };
  }
  return { valid: true, iso: d.toISOString() };
}

export interface StagingExportRow {
  output_id: string;
  source_id: string;
  staging_agent_id: string;
  payload: any;
  ledger_agent_id: string;
  outcome: string;
  output_ids?: string[];
}

export interface ExportJsonlRecord {
  import_key: string;
  company_id: string;
  agent_id: string;
  text: string;
  created_at: string | null;
  type: string | null;
  subject: string | null;
  confidence: number;
  migrated_from: string;
  migration_id: string;
  converter_id: string;
  converter_version: number;
}

export interface TransformStagingResult {
  records: ExportJsonlRecord[];
  perTypeCounts: Record<string, number>;
  charLengths: number[];
  totalChars: number;
}
