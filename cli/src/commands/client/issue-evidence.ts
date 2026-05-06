import {
  EVIDENCE_RECORDS_DOCUMENT_KEY,
  evidenceRecordSchema,
  evidenceRecordsDocumentSchema,
  formatEvidenceRecordsDocumentBody,
  parseEvidenceRecordsDocumentBody,
  type EvidenceRecord,
} from "@paperclipai/shared";

export interface EvidenceRecordCliOptions {
  id: string;
  gateId: string;
  gateType: string;
  status?: string;
  timestamp?: string;
  issueId?: string;
  agentId?: string;
  agentName?: string;
  runId?: string;
  repo?: string;
  branch?: string;
  commitSha?: string;
  command?: string[];
  url?: string[];
  screenshot?: string[];
  artifact?: string[];
  notes?: string;
}

export interface EvidenceRecordIssueDocument {
  key: typeof EVIDENCE_RECORDS_DOCUMENT_KEY;
  title: string;
  format: "markdown";
  body: string;
  changeSummary: string;
}

export function collectRepeatableOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function buildEvidenceRecordFromOptions(options: EvidenceRecordCliOptions): EvidenceRecord {
  return evidenceRecordSchema.parse({
    id: options.id,
    gateId: options.gateId,
    gateType: options.gateType,
    status: options.status ?? "passed",
    timestamp: options.timestamp ?? new Date().toISOString(),
    issueId: emptyToNull(options.issueId),
    agentId: emptyToNull(options.agentId),
    agentName: emptyToNull(options.agentName),
    runId: emptyToNull(options.runId),
    repo: emptyToNull(options.repo),
    branch: emptyToNull(options.branch),
    commitSha: emptyToNull(options.commitSha),
    commands: (options.command ?? []).map((command) => ({
      command,
      status: options.status ?? "passed",
      ...(options.status === "failed" ? { exitCode: 1 } : { exitCode: 0 }),
    })),
    urls: (options.url ?? []).map(parseLabeledValue),
    screenshots: (options.screenshot ?? []).map(parseLabeledPath),
    artifacts: (options.artifact ?? []).map(parseLabeledPath),
    notes: emptyToNull(options.notes),
  });
}

export function appendEvidenceRecordDocument(
  existingBody: string | null | undefined,
  record: EvidenceRecord,
): EvidenceRecordIssueDocument {
  const current = existingBody
    ? parseEvidenceRecordsDocumentBody(existingBody)
    : evidenceRecordsDocumentSchema.parse({ version: 1, records: [] });
  if (current.records.some((existingRecord) => existingRecord.id === record.id)) {
    throw new Error(`Evidence record "${record.id}" already exists`);
  }
  return {
    key: EVIDENCE_RECORDS_DOCUMENT_KEY,
    title: "Evidence Records",
    format: "markdown",
    body: formatEvidenceRecordsDocumentBody({
      version: 1,
      records: [...current.records, record],
    }),
    changeSummary: `Append evidence record ${record.id}`,
  };
}

function parseLabeledValue(raw: string) {
  const index = raw.indexOf("=");
  if (index < 0) {
    return { label: raw, url: raw };
  }
  return {
    label: raw.slice(0, index).trim(),
    url: raw.slice(index + 1).trim(),
  };
}

function parseLabeledPath(raw: string) {
  const index = raw.indexOf("=");
  if (index < 0) {
    return { label: raw, path: raw };
  }
  return {
    label: raw.slice(0, index).trim(),
    path: raw.slice(index + 1).trim(),
  };
}

function emptyToNull(value: string | undefined) {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
