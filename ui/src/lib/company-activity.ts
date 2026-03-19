import type { ActivityListFilters } from "@paperclipai/shared";

export const COMPANY_ACTIVITY_POLL_INTERVAL_MS = 15_000;

export interface ActivityPageFilterState {
  agentId: string;
  entityType: string;
  action: string;
}

export function getCompanyActivityRefetchInterval(input: { isDocumentVisible: boolean }): number | false {
  return input.isDocumentVisible ? COMPANY_ACTIVITY_POLL_INTERVAL_MS : false;
}

export function normalizeActivityListFilters(filters: ActivityPageFilterState): ActivityListFilters {
  const normalized: ActivityListFilters = {};

  const agentId = filters.agentId.trim();
  if (agentId) normalized.agentId = agentId;

  const entityType = filters.entityType.trim();
  if (entityType && entityType !== "all") normalized.entityType = entityType;

  const action = filters.action.trim();
  if (action) normalized.action = action;

  return normalized;
}
