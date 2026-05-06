import type {
  EvidenceRecordStatus,
  GateManifestGateType,
} from "../constants.js";

export interface EvidenceCommandRecord {
  command: string;
  cwd?: string;
  exitCode?: number;
  status: EvidenceRecordStatus;
  outputSummary?: string;
}

export interface EvidenceUrlRecord {
  label: string;
  url: string;
}

export interface EvidenceArtifactRecord {
  label: string;
  path: string;
  sha256?: string;
}

export interface EvidenceScreenshotRecord extends EvidenceArtifactRecord {
  viewport?: string;
}

export interface EvidenceRecord {
  id: string;
  gateId: string;
  gateType: GateManifestGateType;
  status: EvidenceRecordStatus;
  timestamp: string;
  issueId?: string | null;
  agentId?: string | null;
  agentName?: string | null;
  runId?: string | null;
  repo?: string | null;
  branch?: string | null;
  commitSha?: string | null;
  commands: EvidenceCommandRecord[];
  urls: EvidenceUrlRecord[];
  screenshots: EvidenceScreenshotRecord[];
  artifacts: EvidenceArtifactRecord[];
  notes?: string | null;
}

export interface EvidenceRecordsDocument {
  version: 1;
  records: EvidenceRecord[];
}
