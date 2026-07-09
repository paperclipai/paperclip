import type { HeartbeatRunStatusPhase } from "@paperclipai/shared";
import { redactSensitiveText } from "../redaction.js";

export const HEARTBEAT_RUN_RUNTIME_STATUS_TTL_MS = 90_000;
export const MAX_HEARTBEAT_RUN_RUNTIME_STATUS_MESSAGE_CHARS = 180;

export interface HeartbeatRunRuntimeStatus {
  companyId: string;
  issueId: string | null;
  agentId: string;
  runId: string;
  phase: HeartbeatRunStatusPhase;
  message: string;
  updatedAt: Date;
}

const runtimeStatusesByRunId = new Map<string, HeartbeatRunRuntimeStatus>();

function cloneStatus(status: HeartbeatRunRuntimeStatus): HeartbeatRunRuntimeStatus {
  return {
    ...status,
    updatedAt: new Date(status.updatedAt),
  };
}

export function sanitizeHeartbeatRunRuntimeStatusMessage(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  const redacted = redactSensitiveText(normalized);
  if (redacted.length <= MAX_HEARTBEAT_RUN_RUNTIME_STATUS_MESSAGE_CHARS) return redacted;
  return `${redacted.slice(0, MAX_HEARTBEAT_RUN_RUNTIME_STATUS_MESSAGE_CHARS - 3)}...`;
}

function isExpired(status: HeartbeatRunRuntimeStatus, now: Date, ttlMs: number) {
  return now.getTime() - status.updatedAt.getTime() > ttlMs;
}

export function setHeartbeatRunRuntimeStatus(
  input: Omit<HeartbeatRunRuntimeStatus, "message" | "updatedAt"> & {
    message: string;
    updatedAt?: Date;
  },
): HeartbeatRunRuntimeStatus | null {
  const message = sanitizeHeartbeatRunRuntimeStatusMessage(input.message);
  if (!message) {
    clearHeartbeatRunRuntimeStatus(input.runId);
    return null;
  }

  const status: HeartbeatRunRuntimeStatus = {
    companyId: input.companyId,
    issueId: input.issueId,
    agentId: input.agentId,
    runId: input.runId,
    phase: input.phase,
    message,
    updatedAt: input.updatedAt ? new Date(input.updatedAt) : new Date(),
  };
  runtimeStatusesByRunId.set(status.runId, status);
  return cloneStatus(status);
}

export function getHeartbeatRunRuntimeStatus(
  runId: string,
  expected?: {
    companyId?: string | null;
    issueId?: string | null;
    agentId?: string | null;
    now?: Date;
    ttlMs?: number;
  },
): HeartbeatRunRuntimeStatus | null {
  const status = runtimeStatusesByRunId.get(runId);
  if (!status) return null;

  const now = expected?.now ?? new Date();
  const ttlMs = expected?.ttlMs ?? HEARTBEAT_RUN_RUNTIME_STATUS_TTL_MS;
  if (isExpired(status, now, ttlMs)) {
    runtimeStatusesByRunId.delete(runId);
    return null;
  }

  if (expected?.companyId !== undefined && status.companyId !== expected.companyId) return null;
  if (expected?.issueId !== undefined && status.issueId !== expected.issueId) return null;
  if (expected?.agentId !== undefined && status.agentId !== expected.agentId) return null;

  return cloneStatus(status);
}

export function clearHeartbeatRunRuntimeStatus(runId: string): boolean {
  return runtimeStatusesByRunId.delete(runId);
}

export function clearAllHeartbeatRunRuntimeStatuses(): void {
  runtimeStatusesByRunId.clear();
}

export function sweepExpiredHeartbeatRunRuntimeStatuses(
  now = new Date(),
  ttlMs = HEARTBEAT_RUN_RUNTIME_STATUS_TTL_MS,
): number {
  let swept = 0;
  for (const [runId, status] of runtimeStatusesByRunId) {
    if (!isExpired(status, now, ttlMs)) continue;
    runtimeStatusesByRunId.delete(runId);
    swept += 1;
  }
  return swept;
}
