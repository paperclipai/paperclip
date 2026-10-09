function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function readDateMs(value: unknown): number | null {
  if (!(typeof value === "string" || value instanceof Date)) return null;
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isNaN(time) ? null : time;
}

export type MonitorWaitingIssue = {
  monitorNextCheckAt?: Date | string | null;
  executionPolicy?: Record<string, unknown> | null;
  executionState?: Record<string, unknown> | null;
  monitorAttemptCount?: number | null;
};

function monitorFromIssue(issue: MonitorWaitingIssue) {
  const policyMonitor = readRecord(readRecord(issue.executionPolicy)?.monitor);
  const stateMonitor = readRecord(readRecord(issue.executionState)?.monitor);
  return { policyMonitor, stateMonitor };
}

export function hasHumanOrBoardUnblockWaitingPath(descriptor: unknown): boolean {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) return false;
  const owner = (descriptor as { owner?: unknown }).owner;
  if (owner === "board") return true;
  if (!owner || typeof owner !== "object" || Array.isArray(owner)) return false;
  const userId = (owner as { userId?: unknown }).userId;
  return typeof userId === "string" && userId.length > 0;
}

export function hasScheduledIssueMonitorPath(issue: MonitorWaitingIssue, now: Date | string | number) {
  const nowMs = typeof now === "number" ? now : readDateMs(now) ?? Date.now();
  const { policyMonitor, stateMonitor } = monitorFromIssue(issue);
  const candidates = [
    readDateMs(issue.monitorNextCheckAt),
    readDateMs(policyMonitor?.nextCheckAt),
    readDateMs(stateMonitor?.nextCheckAt),
  ].filter((value): value is number => value !== null);
  const nextCheckAtMs = candidates.length > 0 ? Math.max(...candidates) : null;
  if (nextCheckAtMs === null || nextCheckAtMs <= nowMs) return false;

  const timeoutAtMs = readDateMs(policyMonitor?.timeoutAt ?? stateMonitor?.timeoutAt);
  if (timeoutAtMs !== null && timeoutAtMs <= nowMs) return false;

  const maxAttempts = readPositiveInteger(policyMonitor?.maxAttempts ?? stateMonitor?.maxAttempts);
  const stateAttemptCount = readPositiveInteger(stateMonitor?.attemptCount) ?? 0;
  const attemptCount = issue.monitorAttemptCount ?? stateAttemptCount;
  if (maxAttempts !== null && attemptCount >= maxAttempts) return false;

  return true;
}

export function shouldRefuseBlockedReopen(
  issue: MonitorWaitingIssue & { status: string; unblockDescriptor?: unknown },
  now: Date,
) {
  return issue.status === "blocked" && (
    hasHumanOrBoardUnblockWaitingPath(issue.unblockDescriptor) ||
    hasScheduledIssueMonitorPath(issue, now)
  );
}
