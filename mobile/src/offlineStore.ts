import AsyncStorage from "@react-native-async-storage/async-storage";

import type {
  IssueComment,
  IssueDetail,
  IssueStatus,
  IssueSummary,
} from "./paperclipApi";

const STORAGE_KEYS = {
  inboxCache: "paperclip.mobile.offline.inbox.v1",
  issueDetailPrefix: "paperclip.mobile.offline.issue-detail.v1",
  issueCommentsPrefix: "paperclip.mobile.offline.issue-comments.v1",
  mutationQueue: "paperclip.mobile.offline.mutation-queue.v1",
  replayResults: "paperclip.mobile.offline.replay-results.v1",
} as const;

const MAX_REPLAY_RESULTS = 40;

interface StoredEnvelope<TValue> {
  cachedAt: string;
  value: TValue;
}

export interface CachedIssueList {
  cachedAt: string;
  issues: IssueSummary[];
}

export interface CachedIssueDetail {
  cachedAt: string;
  detail: IssueDetail;
}

export interface CachedIssueComments {
  cachedAt: string;
  comments: IssueComment[];
}

export type PendingMutationKind = "checkout" | "comment" | "status";

interface PendingMutationBase {
  id: string;
  issueId: string;
  createdAt: string;
  attempts: number;
  runId: string;
}

export interface PendingCheckoutMutation extends PendingMutationBase {
  kind: "checkout";
}

export interface PendingCommentMutation extends PendingMutationBase {
  kind: "comment";
  body: string;
}

export interface PendingStatusMutation extends PendingMutationBase {
  kind: "status";
  status: IssueStatus;
}

export type PendingMutation =
  | PendingCheckoutMutation
  | PendingCommentMutation
  | PendingStatusMutation;

export type PendingMutationDraft =
  | Omit<PendingCheckoutMutation, "id" | "createdAt" | "attempts">
  | Omit<PendingCommentMutation, "id" | "createdAt" | "attempts">
  | Omit<PendingStatusMutation, "id" | "createdAt" | "attempts">;

export type ReplayResultOutcome = "applied" | "conflict" | "failed";

export interface ReplayResult {
  id: string;
  mutationId: string;
  issueId: string;
  kind: PendingMutationKind;
  outcome: ReplayResultOutcome;
  message: string;
  createdAt: string;
}

function issueDetailKey(issueId: string): string {
  return `${STORAGE_KEYS.issueDetailPrefix}:${issueId}`;
}

function issueCommentsKey(issueId: string): string {
  return `${STORAGE_KEYS.issueCommentsPrefix}:${issueId}`;
}

async function readJson<TValue>(key: string): Promise<TValue | null> {
  const raw = await AsyncStorage.getItem(key);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as TValue;
  } catch {
    return null;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify(value));
}

export async function loadCachedIssueList(): Promise<CachedIssueList | null> {
  const envelope = await readJson<StoredEnvelope<IssueSummary[]>>(STORAGE_KEYS.inboxCache);
  if (!envelope?.cachedAt || !Array.isArray(envelope.value)) {
    return null;
  }

  return {
    cachedAt: envelope.cachedAt,
    issues: envelope.value,
  };
}

export async function saveCachedIssueList(issues: IssueSummary[]): Promise<CachedIssueList> {
  const cachedAt = new Date().toISOString();
  await writeJson(STORAGE_KEYS.inboxCache, {
    cachedAt,
    value: issues,
  } satisfies StoredEnvelope<IssueSummary[]>);

  return { cachedAt, issues };
}

export async function loadCachedIssueDetail(issueId: string): Promise<CachedIssueDetail | null> {
  const envelope = await readJson<StoredEnvelope<IssueDetail>>(issueDetailKey(issueId));
  if (!envelope?.cachedAt || !envelope.value) {
    return null;
  }

  return {
    cachedAt: envelope.cachedAt,
    detail: envelope.value,
  };
}

export async function saveCachedIssueDetail(detail: IssueDetail): Promise<CachedIssueDetail> {
  const cachedAt = new Date().toISOString();
  await writeJson(issueDetailKey(detail.id), {
    cachedAt,
    value: detail,
  } satisfies StoredEnvelope<IssueDetail>);

  return {
    cachedAt,
    detail,
  };
}

export async function loadCachedIssueComments(
  issueId: string,
): Promise<CachedIssueComments | null> {
  const envelope = await readJson<StoredEnvelope<IssueComment[]>>(issueCommentsKey(issueId));
  if (!envelope?.cachedAt || !Array.isArray(envelope.value)) {
    return null;
  }

  return {
    cachedAt: envelope.cachedAt,
    comments: envelope.value,
  };
}

export async function saveCachedIssueComments(
  issueId: string,
  comments: IssueComment[],
): Promise<CachedIssueComments> {
  const cachedAt = new Date().toISOString();
  await writeJson(issueCommentsKey(issueId), {
    cachedAt,
    value: comments,
  } satisfies StoredEnvelope<IssueComment[]>);

  return {
    cachedAt,
    comments,
  };
}

export async function loadPendingMutations(): Promise<PendingMutation[]> {
  const queued = await readJson<PendingMutation[]>(STORAGE_KEYS.mutationQueue);
  if (!Array.isArray(queued)) {
    return [];
  }

  return queued;
}

export async function savePendingMutations(queue: PendingMutation[]): Promise<void> {
  await writeJson(STORAGE_KEYS.mutationQueue, queue);
}

export async function loadReplayResults(): Promise<ReplayResult[]> {
  const history = await readJson<ReplayResult[]>(STORAGE_KEYS.replayResults);
  if (!Array.isArray(history)) {
    return [];
  }

  return history;
}

export async function appendReplayResult(result: ReplayResult): Promise<ReplayResult[]> {
  const existing = await loadReplayResults();
  const next = [result, ...existing].slice(0, MAX_REPLAY_RESULTS);
  await writeJson(STORAGE_KEYS.replayResults, next);
  return next;
}

export function makeMutationId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export function makeReplayResultId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}
