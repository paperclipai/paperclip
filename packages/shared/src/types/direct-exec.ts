import type {
  DirectExecAnswerCategory,
  DirectExecLifecycleStatus,
  DirectExecScrubStatus,
  DirectExecSurfaceType,
  DirectExecVisibility,
} from "../constants.js";
import type { Issue } from "./issue.js";

export interface DirectExecThresholds {
  ackDeadlineSeconds: number;
  targetReceiptDeadlineSeconds: number;
  responseTimeoutSeconds: number;
  deliveryRetryLimit: number;
  pendingStatusCadenceSeconds: number;
  paperclipReadMaxAgeSeconds: number;
  runtimeStatusMaxAgeSeconds: number;
  heartbeatFreshSeconds: number;
}

export interface DirectExecSourceMetadata {
  channel: string;
  chatId: string;
  messageId: string;
  senderId: string;
  senderLabel: string | null;
  surfaceType: DirectExecSurfaceType;
  threadId: string | null;
  replyToMessageId: string | null;
  receivedAt: string | null;
}

export interface DirectExecTargetMetadata {
  alias: string;
  agentIds: string[];
}

export interface DirectExecDeliveryReceipt {
  id: string;
  channel: string;
  targetId: string;
  deliveredAt: string | null;
  status: "queued" | "delivered" | "failed";
  error: string | null;
}

export interface DirectExecLifecycle {
  status: DirectExecLifecycleStatus;
  source: DirectExecSourceMetadata;
  dedupeKey: string;
  target: DirectExecTargetMetadata;
  visibility: DirectExecVisibility;
  contextBundleId: string | null;
  wakeReceiptIds: string[];
  responseIds: string[];
  deliveryReceipts: DirectExecDeliveryReceipt[];
  timeoutAt: string | null;
  retentionExpiresAt: string | null;
  scrubStatus: DirectExecScrubStatus;
  thresholds: DirectExecThresholds;
  statusReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DirectExecContextSourceFreshness {
  sourceName: string;
  sourceId: string;
  fetchedAt: string;
  maxAgeSeconds: number;
  stale: boolean;
  unavailableReason: string | null;
  errorReason: string | null;
}

export interface DirectExecContextConflict {
  field: string;
  sources: string[];
  resolution: "live_paperclip" | "target_authored" | "newer_same_source" | "unresolved";
  surfaced: boolean;
  evidence: string;
}

export interface DirectExecContextItem {
  sourceName: string;
  sourceId: string;
  kind: string;
  data: Record<string, unknown>;
}

export interface DirectExecAnswerEvidence {
  sourceName: string;
  sourceId: string;
  detail: string;
}

export type DirectExecAnswerEvidenceByCategory = Partial<
  Record<DirectExecAnswerCategory, DirectExecAnswerEvidence[]>
>;

export interface DirectExecContextBundle {
  id: string;
  companyId: string;
  directExecThreadId: string;
  issueId: string;
  sources: DirectExecContextSourceFreshness[];
  items: DirectExecContextItem[];
  conflicts: DirectExecContextConflict[];
  answerCategory: DirectExecAnswerCategory | null;
  answerEvidence: DirectExecAnswerEvidenceByCategory;
  createdAt: Date;
  updatedAt: Date;
}

export interface DirectExecThread {
  id: string;
  companyId: string;
  issueId: string | null;
  originKind: "direct_exec";
  originId: string;
  originRunId: string | null;
  lifecycle: DirectExecLifecycle;
  issue?: Issue | null;
  contextBundle?: DirectExecContextBundle | null;
  createdAt: Date;
  updatedAt: Date;
}
