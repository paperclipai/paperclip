import type { TFunction } from "i18next";

const STATUS_TRANSLATION_KEYS: Record<string, string> = {
  active: "status.active",
  approved: "status.approved",
  archived: "status.archived",
  backlog: "status.backlog",
  blocked: "status.blocked",
  cancelled: "status.cancelled",
  done: "status.done",
  error: "status.error",
  failed: "status.failed",
  queued: "status.queued",
  idle: "status.idle",
  in_progress: "status.inProgress",
  in_review: "status.inReview",
  paused: "status.paused",
  pending: "status.pending",
  pending_approval: "status.pendingApproval",
  rejected: "status.rejected",
  revision_requested: "status.revisionRequested",
  running: "status.running",
  skipped: "status.skipped",
  starting: "status.starting",
  succeeded: "status.succeeded",
  timed_out: "status.timedOut",
  terminated: "status.terminated",
  todo: "status.todo",
};

const PRIORITY_TRANSLATION_KEYS: Record<string, string> = {
  critical: "priority.critical",
  high: "priority.high",
  medium: "priority.medium",
  low: "priority.low",
};

const ENTITY_TYPE_TRANSLATION_KEYS: Record<string, string> = {
  agent: "entityType.agent",
  approval: "entityType.approval",
  company: "entityType.company",
  cost: "entityType.cost",
  goal: "entityType.goal",
  heartbeat_run: "entityType.heartbeatRun",
  invite: "entityType.invite",
  issue: "entityType.issue",
  project: "entityType.project",
  routine: "entityType.routine",
  routine_run: "entityType.routineRun",
  routine_trigger: "entityType.routineTrigger",
};

export function humanizeEnumValue(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export function translateStatusLabel(t: TFunction, status: string): string {
  return t(STATUS_TRANSLATION_KEYS[status] ?? status, {
    defaultValue: humanizeEnumValue(status),
  });
}

export function translatePriorityLabel(t: TFunction, priority: string): string {
  return t(PRIORITY_TRANSLATION_KEYS[priority] ?? priority, {
    defaultValue: humanizeEnumValue(priority),
  });
}

export function translateEntityTypeLabel(t: TFunction, entityType: string): string {
  return t(ENTITY_TYPE_TRANSLATION_KEYS[entityType] ?? entityType, {
    defaultValue: humanizeEnumValue(entityType),
  });
}
