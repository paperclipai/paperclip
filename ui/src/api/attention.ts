import type {
  AttentionClaimResult,
  AttentionCloseInput,
  AttentionCloseResult,
  AttentionFeed,
  AttentionSummary,
  AttentionTaskIndex,
  AttentionFeedQuery,
  AttentionSourceKind,
  AttentionTransferInput,
  AttentionTransferResult,
  DecisionHistoryPage,
  DecisionHistoryQuery,
} from "@paperclipai/shared";
import { api } from "./client";

function cardPath(companyId: string, sourceKind: AttentionSourceKind, sourceId: string, action: string) {
  return `/companies/${companyId}/attention/${encodeURIComponent(sourceKind)}/${encodeURIComponent(sourceId)}/${action}`;
}

export const attentionApi = {
  summary: (companyId: string) => api.get<AttentionSummary>(`/companies/${companyId}/attention/summary`),
  taskIndex: (companyId: string) => api.get<AttentionTaskIndex>(`/companies/${companyId}/attention/tasks`),
  history: (companyId: string, options: DecisionHistoryQuery = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) if (value !== undefined && value !== "") params.set(key, String(value));
    return api.get<DecisionHistoryPage>(`/companies/${companyId}/attention/history?${params.toString()}`);
  },
  /**
   * Fetch the ranked Decisions attention feed for a company. The server
   * unions every attention source (approvals, interactions, recovery, reviews,
   * failures, budget…) into one ranked queue with the §0 contract.
   */
  list: (companyId: string, options: AttentionFeedQuery = {}) => {
    const params = new URLSearchParams();
    if (options.includeDismissed) params.set("includeDismissed", "true");
    if (options.archived) params.set("archived", "true");
    if (options.all) params.set("all", "true");
    if (options.view) params.set("view", options.view);
    if (options.activitySince) params.set("activitySince", options.activitySince);
    if (options.activityUntil) params.set("activityUntil", options.activityUntil);
    if (options.queue) params.set("queue", options.queue);
    if (options.sort) params.set("sort", options.sort);
    if (options.cursor) params.set("cursor", options.cursor);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const query = params.toString();
    return api.get<AttentionFeed>(`/companies/${companyId}/attention${query ? `?${query}` : ""}`);
  },
  /** Claim an Unassigned card: you become its addressee (PAP-749 plan §1, Rule 3). */
  claim: (companyId: string, sourceKind: AttentionSourceKind, sourceId: string) =>
    api.post<AttentionClaimResult>(cardPath(companyId, sourceKind, sourceId, "claim"), {}),
  /**
   * One Close… menu verb (PAP-749 plan §2, Rule 6): withdraw the request for
   * everyone, or archive / snooze the card for yourself. Use the card's
   * `closeModes` to know which verbs it supports.
   */
  close: (companyId: string, sourceKind: AttentionSourceKind, sourceId: string, input: AttentionCloseInput) =>
    api.post<AttentionCloseResult>(cardPath(companyId, sourceKind, sourceId, "close"), input),
  /** Route a card to a different person; they become its addressee. */
  transfer: (companyId: string, sourceKind: AttentionSourceKind, sourceId: string, input: AttentionTransferInput) =>
    api.post<AttentionTransferResult>(cardPath(companyId, sourceKind, sourceId, "transfer"), input),
};
