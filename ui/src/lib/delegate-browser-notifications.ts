import type { Issue } from "@paperclipai/shared";

export const DELEGATE_NOTIFICATION_SETTINGS_EVENT = "paperclip:delegate-notifications-changed";
export const DELEGATE_NOTIFICATION_POLL_INTERVAL_MS = 15_000;

const STORAGE_PREFIX = "paperclip:delegate-notifications";
const MAX_DELIVERED_KEYS = 200;

export type DelegateNotificationKind = "blocked" | "ready";

export interface DelegateNotificationCandidate {
  body: string;
  href: string;
  key: string;
  kind: DelegateNotificationKind;
  tag: string;
  title: string;
}

function enabledStorageKey(companyId: string) {
  return `${STORAGE_PREFIX}:${companyId}:enabled`;
}

function deliveredStorageKey(companyId: string) {
  return `${STORAGE_PREFIX}:${companyId}:delivered`;
}

function safeStorage(): Storage | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

function readDeliveredKeys(companyId: string): string[] {
  const storage = safeStorage();
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(deliveredStorageKey(companyId)) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string").slice(-MAX_DELIVERED_KEYS)
      : [];
  } catch {
    return [];
  }
}

function writeDeliveredKeys(companyId: string, keys: string[]) {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(deliveredStorageKey(companyId), JSON.stringify(keys.slice(-MAX_DELIVERED_KEYS)));
  } catch {
    // Browser storage can be unavailable or full. A notification failure must
    // not interrupt the rest of the Paperclip UI.
  }
}

function timestamp(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function notificationBody(issue: Issue) {
  const reviewEstimate = issue.estimatedReviewMinutes
    ? ` · ${issue.estimatedReviewMinutes} min review`
    : "";
  return `${issue.title}${reviewEstimate}`;
}

function notificationVersion(issue: Issue) {
  if (typeof issue.statusVersion === "number") return String(issue.statusVersion);
  return String(timestamp(issue.updatedAt) ?? 0);
}

function candidateForIssue(issue: Issue, companyId: string, now: Date): DelegateNotificationCandidate | null {
  if (issue.companyId !== companyId || issue.workMode === "planning") return null;

  let kind: DelegateNotificationKind;
  let scheduleVersion: string;
  if (issue.status === "blocked") {
    kind = "blocked";
    scheduleVersion = "immediate";
  } else if (issue.status === "in_review") {
    const reviewAt = timestamp(issue.reviewBy);
    if (reviewAt !== null && reviewAt > now.getTime()) return null;
    kind = "ready";
    scheduleVersion = reviewAt === null ? "immediate" : new Date(reviewAt).toISOString();
  } else {
    return null;
  }

  const key = [companyId, issue.id, kind, scheduleVersion, notificationVersion(issue)].join("|");
  return {
    body: notificationBody(issue),
    href: `/issues/${issue.identifier ?? issue.id}`,
    key,
    kind,
    tag: `paperclip-${key}`,
    title: kind === "ready" ? "Ready to review" : "Needs you",
  };
}

export function getDueDelegateNotifications(
  issues: Issue[],
  companyId: string,
  now = new Date(),
): DelegateNotificationCandidate[] {
  const delivered = new Set(readDeliveredKeys(companyId));
  return issues
    .map((issue) => candidateForIssue(issue, companyId, now))
    .filter((candidate): candidate is DelegateNotificationCandidate => (
      candidate !== null && !delivered.has(candidate.key)
    ));
}

export function claimDelegateNotification(companyId: string, key: string): boolean {
  const keys = readDeliveredKeys(companyId);
  if (keys.includes(key)) return false;
  writeDeliveredKeys(companyId, [...keys, key]);
  return true;
}

export function releaseDelegateNotification(companyId: string, key: string) {
  writeDeliveredKeys(companyId, readDeliveredKeys(companyId).filter((candidate) => candidate !== key));
}

export function isDelegateBrowserNotificationsEnabled(companyId: string | null | undefined): boolean {
  if (!companyId) return false;
  return safeStorage()?.getItem(enabledStorageKey(companyId)) === "1";
}

export function setDelegateBrowserNotificationsEnabled(companyId: string, enabled: boolean) {
  const storage = safeStorage();
  try {
    if (enabled) storage?.setItem(enabledStorageKey(companyId), "1");
    else storage?.removeItem(enabledStorageKey(companyId));
  } catch {
    // The caller still updates its in-memory state when local storage is unavailable.
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(DELEGATE_NOTIFICATION_SETTINGS_EVENT, {
      detail: { companyId, enabled },
    }));
  }
}

export function delegateNotificationStorageKey(companyId: string) {
  return enabledStorageKey(companyId);
}
