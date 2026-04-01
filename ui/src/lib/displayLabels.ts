import { formatMessage, type ActiveLocale } from "../i18n";
import { getRuntimeLocale } from "../i18n/runtime";

function humanizeToken(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

const statusKeys: Record<string, string> = {
  active: "labels.status.active",
  running: "labels.status.running",
  paused: "labels.status.paused",
  idle: "labels.status.idle",
  archived: "labels.status.archived",
  planned: "labels.status.planned",
  achieved: "labels.status.achieved",
  completed: "labels.status.completed",
  failed: "labels.status.failed",
  timed_out: "labels.status.timed_out",
  succeeded: "labels.status.succeeded",
  error: "labels.status.error",
  pending_approval: "labels.status.pending_approval",
  backlog: "labels.status.backlog",
  todo: "labels.status.todo",
  in_progress: "labels.status.in_progress",
  in_review: "labels.status.in_review",
  blocked: "labels.status.blocked",
  done: "labels.status.done",
  terminated: "labels.status.terminated",
  cancelled: "labels.status.cancelled",
  pending: "labels.status.pending",
  revision_requested: "labels.status.revision_requested",
  approved: "labels.status.approved",
  rejected: "labels.status.rejected",
};

const priorityKeys: Record<string, string> = {
  critical: "labels.priority.critical",
  high: "labels.priority.high",
  medium: "labels.priority.medium",
  low: "labels.priority.low",
};

const invocationKeys: Record<string, string> = {
  timer: "labels.invocation.timer",
  assignment: "labels.invocation.assignment",
  on_demand: "labels.invocation.on_demand",
  automation: "labels.invocation.automation",
};

export function localizedStatusLabel(status: string, locale: ActiveLocale = getRuntimeLocale()) {
  const key = statusKeys[status];
  return key ? formatMessage(locale, key) : humanizeToken(status);
}

export function localizedPriorityLabel(priority: string, locale: ActiveLocale = getRuntimeLocale()) {
  const key = priorityKeys[priority];
  return key ? formatMessage(locale, key) : humanizeToken(priority);
}

export function localizedInvocationLabel(invocation: string, locale: ActiveLocale = getRuntimeLocale()) {
  const key = invocationKeys[invocation];
  return key ? formatMessage(locale, key) : humanizeToken(invocation);
}
