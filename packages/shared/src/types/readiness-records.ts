import type {
  ReadinessCheckType,
  ReadinessRecordStatus,
} from "../constants.js";

export interface ReadinessCheckRecord {
  type: ReadinessCheckType;
  status: ReadinessRecordStatus;
  message?: string;
  detail?: string;
  command?: string;
}

export interface ReadinessRecord {
  id: string;
  agentId?: string | null;
  agentName?: string | null;
  status: ReadinessRecordStatus;
  timestamp: string;
  expiresAt?: string | null;
  issueId?: string | null;
  runId?: string | null;
  checks: ReadinessCheckRecord[];
  notes?: string | null;
}

export interface ReadinessRecordsDocument {
  version: 1;
  records: ReadinessRecord[];
}
