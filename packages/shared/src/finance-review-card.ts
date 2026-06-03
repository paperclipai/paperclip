export const FINANCE_REVIEW_CARD_DOCUMENT_KEY = "finance-review-card" as const;

export interface FinancePendingRecord {
  metricKey: string;
  displayLabel?: string | null;
  family?: string | null;
  period?: string | null;
  timeGrain?: string | null;
  scenario?: string | null;
  value?: number | string | null;
  unit?: string | null;
  dimensions?: Record<string, unknown> | null;
  reviewStatus?: string | null;
  sourceSheet?: string | null;
  sourceRange?: string | null;
  sourceGroup?: string | null;
  parserId?: string | null;
}

export interface FinancePendingReviewArtifact {
  artifactType?: string;
  reviewMode?: string;
  finalizationStatus?: string;
  sourceWorkbook?: string | null;
  sourcePath?: string | null;
  sourceSha256?: string | null;
  sourceModifiedAt?: string | null;
  importRunId?: string | null;
  actualThroughPeriod?: string | null;
  integrityStatus?: string | null;
  pendingReviewCount?: number | null;
  acceptedRecordCount?: number | null;
  rejectedRecordCount?: number | null;
  conflictCount?: number | null;
  baselineDifferenceCount?: number | null;
  reconciliationSummary?: {
    differenceCount?: number | null;
    differences?: Array<Record<string, unknown>> | null;
  } | null;
  integritySummary?: Record<string, unknown> | null;
  reviewItems?: Array<{ title?: string | null; type?: string | null } | Record<string, unknown>> | null;
  pendingRecords?: FinancePendingRecord[] | null;
  nextActions?: string[] | null;
}

export interface FinanceReviewCardSummary {
  documentKey: typeof FINANCE_REVIEW_CARD_DOCUMENT_KEY;
  title: string;
  sourceWorkbook: string;
  actualThroughPeriod: string;
  finalizationStatus: string;
  integrityStatus: string;
  pendingReviewCount: number;
  acceptedRecordCount: number;
  rejectedRecordCount: number;
  conflictCount: number;
  differenceCount: number;
  nextActionLabel: string;
  primaryMetrics: string[];
  reviewWarnings: string[];
}

export interface FormattedFinanceReviewCard {
  documentKey: typeof FINANCE_REVIEW_CARD_DOCUMENT_KEY;
  title: string;
  markdown: string;
  summary: FinanceReviewCardSummary;
}

function asCount(value: number | null | undefined): number {
  return Number.isFinite(value) ? Number(value) : 0;
}

function periodLabel(period: string | null | undefined): string {
  if (!period) {
    return "latest financials";
  }
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) {
    return period;
  }
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  return new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(date).replace(/^./, (char) => char.toUpperCase());
}

function metricLine(record: FinancePendingRecord): string {
  const label = record.displayLabel || record.metricKey || "Metric";
  const period = record.period || "unknown period";
  const value = record.value ?? "n/a";
  return `${label} · ${period} · ${value}`;
}

export function summarizeFinancePendingReview(input: FinancePendingReviewArtifact): FinanceReviewCardSummary {
  const actualThroughPeriod = input.actualThroughPeriod || "unknown";
  const pendingReviewCount = asCount(input.pendingReviewCount);
  const acceptedRecordCount = asCount(input.acceptedRecordCount);
  const rejectedRecordCount = asCount(input.rejectedRecordCount);
  const conflictCount = asCount(input.conflictCount);
  const differenceCount = asCount(input.reconciliationSummary?.differenceCount ?? input.baselineDifferenceCount);
  const finalizationStatus = input.finalizationStatus || "not_finalized";
  const integrityStatus = input.integrityStatus || "unknown";
  const sourceWorkbook = input.sourceWorkbook || "CFO workbook";
  const primaryMetrics = (input.pendingRecords || []).slice(0, 5).map(metricLine);
  const reviewWarnings = (input.reviewItems || [])
    .map((item) => typeof item.title === "string" ? item.title : null)
    .filter((title): title is string => Boolean(title))
    .slice(0, 5);

  return {
    documentKey: FINANCE_REVIEW_CARD_DOCUMENT_KEY,
    title: `${periodLabel(actualThroughPeriod)} financials need review`,
    sourceWorkbook,
    actualThroughPeriod,
    finalizationStatus,
    integrityStatus,
    pendingReviewCount,
    acceptedRecordCount,
    rejectedRecordCount,
    conflictCount,
    differenceCount,
    nextActionLabel: "Review CFO financials",
    primaryMetrics,
    reviewWarnings,
  };
}

export function formatFinanceReviewCard(input: FinancePendingReviewArtifact): FormattedFinanceReviewCard {
  const summary = summarizeFinancePendingReview(input);
  const lines: string[] = [
    `# ${summary.title}`,
    "",
    `Workbook: ${summary.sourceWorkbook}`,
    `Actual through: ${summary.actualThroughPeriod}`,
    `Status: ${summary.finalizationStatus.replace(/_/g, " ")}`,
    `Integrity: ${summary.integrityStatus}`,
    `Pending review: ${summary.pendingReviewCount}`,
    `Accepted records: ${summary.acceptedRecordCount}`,
    `Differences: ${summary.differenceCount}`,
  ];

  if (summary.conflictCount > 0 || summary.rejectedRecordCount > 0) {
    lines.push(`Exceptions: ${summary.conflictCount} conflicts, ${summary.rejectedRecordCount} rejected`);
  }

  if (summary.primaryMetrics.length) {
    lines.push("", "## Review first", "");
    for (const metric of summary.primaryMetrics) {
      lines.push(`- ${metric}`);
    }
  }

  if (summary.reviewWarnings.length) {
    lines.push("", "## Warnings", "");
    for (const warning of summary.reviewWarnings) {
      lines.push(`- ${warning}`);
    }
  }

  lines.push(
    "",
    "## Actions",
    "",
    "- Review",
    "- Compare to PBI",
    "- Ask CFO",
    "- Hold",
    "",
    "Numbers stay pending until accepted.",
  );

  return {
    documentKey: FINANCE_REVIEW_CARD_DOCUMENT_KEY,
    title: summary.title,
    markdown: lines.join("\n"),
    summary,
  };
}
