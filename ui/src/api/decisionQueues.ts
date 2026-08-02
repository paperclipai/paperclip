import type {
  AttentionSourceKind,
  DecisionQueue,
  DecisionQueueItem,
  DecisionQueueSeedRule,
  DecisionTriage,
} from "@paperclipai/shared";
import { api } from "./client";

// The shared types model timestamps as `Date` (the server row shape); over the
// wire they arrive as ISO strings, so the UI-facing DTOs restate the time
// fields as strings. Everything else round-trips unchanged.
export type DecisionQueueDto = Omit<DecisionQueue, "createdAt" | "updatedAt"> & {
  createdAt: string;
  updatedAt: string;
};
export type DecisionQueueItemDto = Omit<DecisionQueueItem, "createdAt"> & { createdAt: string };
export type DecisionTriageDto = Omit<DecisionTriage, "createdAt" | "updatedAt" | "snoozedUntil"> & {
  createdAt: string;
  updatedAt: string;
  snoozedUntil: string | null;
};

/** A seed rule bundled with its owning queue key/title, from the catalog endpoint. */
export interface DecisionQueueSeedDefinition {
  key: string;
  title: string;
  description: string;
  rules: DecisionQueueSeedRule[];
}

export interface CreateDecisionQueueBody {
  key: string;
  title: string;
  description?: string | null;
  retentionDays?: number | null;
}

export interface UpdateDecisionQueueBody {
  title?: string;
  description?: string | null;
  retentionDays?: number | null;
  seedRulesEnabled?: boolean;
}

export interface UpdateDecisionTriageBody {
  /** `today` | `this_week` | `whenever` | `YYYY-MM-DD` | null to clear. */
  decideBy?: string | null;
  /** ISO timestamp, or null to clear. */
  snoozedUntil?: string | null;
}

/**
 * Decision queues + triage (PAP-16039 P1). Queues are named, company-scoped,
 * durable lists any agent or the board can feed; triage stores the per-source
 * decide-by / snooze that drives the desk's `sort=decide` ordering. The
 * attention feed already surfaces `queues[]` and `decideBy` per item — these
 * routes are the write path and the queue-rail/queue-page read path.
 */
export const decisionQueuesApi = {
  seedRules: (companyId: string) =>
    api.get<DecisionQueueSeedDefinition[]>(`/companies/${companyId}/decision-queue-seed-rules`),

  list: (companyId: string) => api.get<DecisionQueueDto[]>(`/companies/${companyId}/decision-queues`),

  create: (companyId: string, body: CreateDecisionQueueBody) =>
    api.post<DecisionQueueDto>(`/companies/${companyId}/decision-queues`, body),

  update: (companyId: string, key: string, body: UpdateDecisionQueueBody) =>
    api.patch<DecisionQueueDto>(`/companies/${companyId}/decision-queues/${encodeURIComponent(key)}`, body),

  listItems: (companyId: string, key: string) =>
    api.get<DecisionQueueItemDto[]>(`/companies/${companyId}/decision-queues/${encodeURIComponent(key)}/items`),

  addItem: (companyId: string, key: string, sourceKind: AttentionSourceKind, sourceId: string) =>
    api.post<DecisionQueueItemDto>(
      `/companies/${companyId}/decision-queues/${encodeURIComponent(key)}/items`,
      { sourceKind, sourceId },
    ),

  removeItem: (companyId: string, key: string, sourceKind: AttentionSourceKind, sourceId: string) =>
    api.delete<DecisionQueueItemDto>(
      `/companies/${companyId}/decision-queues/${encodeURIComponent(key)}/items/${encodeURIComponent(sourceKind)}/${encodeURIComponent(sourceId)}`,
    ),

  getTriage: (companyId: string, sourceKind: AttentionSourceKind, sourceId: string) =>
    api.get<DecisionTriageDto | null>(
      `/companies/${companyId}/decision-triage/${encodeURIComponent(sourceKind)}/${encodeURIComponent(sourceId)}`,
    ),

  updateTriage: (
    companyId: string,
    sourceKind: AttentionSourceKind,
    sourceId: string,
    body: UpdateDecisionTriageBody,
  ) =>
    api.put<DecisionTriageDto>(
      `/companies/${companyId}/decision-triage/${encodeURIComponent(sourceKind)}/${encodeURIComponent(sourceId)}`,
      body,
    ),
};
