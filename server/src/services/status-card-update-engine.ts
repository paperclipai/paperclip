import { createHash } from "node:crypto";
import type { CompanySearchIssueSummary, StatusCardRefreshPolicy } from "@paperclipai/shared";

export type StatusCardFingerprintEntry = {
  status: string;
  updatedAt: string;
  identifier?: string | null;
  title?: string;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
};

export type StatusCardFingerprint = Record<string, StatusCardFingerprintEntry>;

export type StatusCardDeltaChange = {
  issueId: string;
  identifier: string;
  title: string;
  from: string | null;
  to: string | null;
  changeKind: "new" | "removed" | "status" | "assignee" | "updated";
};

export function buildStatusCardFingerprint(issues: CompanySearchIssueSummary[]): StatusCardFingerprint {
  return Object.fromEntries(issues.map((issue) => [issue.id, {
    status: issue.status,
    updatedAt: issue.updatedAt,
    identifier: issue.identifier,
    title: issue.title,
    assigneeAgentId: issue.assigneeAgentId,
    assigneeUserId: issue.assigneeUserId,
  }]));
}

export function diffStatusCardFingerprint(previous: StatusCardFingerprint | null, current: StatusCardFingerprint) {
  const changes: StatusCardDeltaChange[] = [];
  const before = previous ?? {};
  for (const [issueId, next] of Object.entries(current)) {
    const prior = before[issueId];
    if (!prior) {
      changes.push({ issueId, identifier: next.identifier ?? issueId, title: next.title ?? "", from: null, to: next.status, changeKind: "new" });
      continue;
    }
    if (prior.status !== next.status) {
      changes.push({ issueId, identifier: next.identifier ?? issueId, title: next.title ?? "", from: prior.status, to: next.status, changeKind: "status" });
      continue;
    }
    if (prior.assigneeAgentId !== next.assigneeAgentId || prior.assigneeUserId !== next.assigneeUserId) {
      changes.push({ issueId, identifier: next.identifier ?? issueId, title: next.title ?? "", from: null, to: null, changeKind: "assignee" });
      continue;
    }
    if (prior.updatedAt !== next.updatedAt) {
      changes.push({ issueId, identifier: next.identifier ?? issueId, title: next.title ?? "", from: prior.status, to: next.status, changeKind: "updated" });
    }
  }
  for (const [issueId, prior] of Object.entries(before)) {
    if (current[issueId]) continue;
    changes.push({ issueId, identifier: prior.identifier ?? issueId, title: prior.title ?? "", from: prior.status, to: null, changeKind: "removed" });
  }
  return changes;
}

export function filterStatusCardChanges(changes: StatusCardDeltaChange[], policy: StatusCardRefreshPolicy) {
  const terminalTransitions = new Set(["blocked", "in_review", "done", "cancelled"]);
  return changes.filter((change) => {
    if (policy.triggers.anyUpdate) return true;
    if ((change.changeKind === "new" || change.changeKind === "removed") && policy.triggers.membershipChanges) return true;
    if (change.changeKind === "assignee" && policy.triggers.assigneeChanges) return true;
    if (change.changeKind === "status" && policy.triggers.statusTransitions && change.to && terminalTransitions.has(change.to)) return true;
    return false;
  });
}

export function statusCardFingerprintHash(fingerprint: StatusCardFingerprint) {
  const stable = Object.fromEntries(Object.entries(fingerprint).sort(([left], [right]) => left.localeCompare(right)));
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export function isWithinStatusCardActiveHours(policy: StatusCardRefreshPolicy, now: Date) {
  if (!policy.activeHours) return true;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: policy.activeHours.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  const current = hour * 60 + minute;
  const [startHour, startMinute] = policy.activeHours.start.split(":").map(Number);
  const [endHour, endMinute] = policy.activeHours.end.split(":").map(Number);
  const start = startHour! * 60 + startMinute!;
  const end = endHour! * 60 + endMinute!;
  return start <= end ? current >= start && current < end : current >= start || current < end;
}

export function nextStatusCardEvaluationAt(policy: StatusCardRefreshPolicy, now: Date) {
  const seconds = policy.mode === "interval"
    ? (policy.intervalMinutes ?? 15) * 60
    : policy.mode === "reactive"
      ? Math.min(policy.debounceSeconds ?? 60, 60)
      : 60;
  return new Date(now.getTime() + seconds * 1000);
}

export function chooseStatusCardUpdateKind(input: {
  explicitFull?: boolean;
  hasDocument: boolean;
  changeCount: number;
  queryVersion: number;
  lastUpdateQueryVersion: number | null;
  incrementalCount: number;
  configurationChanged: boolean;
  restoreRefresh?: boolean;
}) {
  if (
    input.explicitFull || !input.hasDocument || input.changeCount > 10 || input.configurationChanged ||
    input.restoreRefresh || input.lastUpdateQueryVersion !== input.queryVersion || input.incrementalCount >= 9
  ) return "full" as const;
  return "incremental" as const;
}

export function evaluateStatusCardPolicy(input: {
  policy: StatusCardRefreshPolicy;
  now: Date;
  lastChangeAt: Date | null;
  updatesLastHour: number;
  tokensToday: number;
  manual: boolean;
}) {
  const cap = input.policy.dailyTokenCap ?? 100_000;
  if (!input.manual && input.tokensToday >= cap) return { action: "pause_budget" as const };
  if (!input.manual && !isWithinStatusCardActiveHours(input.policy, input.now)) return { action: "pause_hours" as const };
  if (input.manual) return { action: "run" as const };
  if (input.policy.mode === "manual") return { action: "wait" as const };
  if (input.policy.mode === "reactive") {
    if (input.updatesLastHour >= (input.policy.maxUpdatesPerHour ?? 6)) return { action: "wait" as const };
    const dueAt = new Date((input.lastChangeAt ?? input.now).getTime() + (input.policy.debounceSeconds ?? 60) * 1000);
    if (dueAt > input.now) return { action: "wait" as const, dueAt };
  }
  return { action: "run" as const };
}
