import type { WorkTimelineResult } from "@paperclipai/shared";
import { api } from "./client";

export interface WorkTimelineParams {
  from?: string;
  to?: string;
  /** lens: work kicked off / touched by this user. */
  userId?: string;
  goalId?: string;
  projectId?: string;
  issueId?: string;
  limit?: number;
}

function query(params: WorkTimelineParams): string {
  const search = new URLSearchParams();
  if (params.from) search.set("from", params.from);
  if (params.to) search.set("to", params.to);
  if (params.userId) search.set("userId", params.userId);
  if (params.goalId) search.set("goalId", params.goalId);
  if (params.projectId) search.set("projectId", params.projectId);
  if (params.issueId) search.set("issueId", params.issueId);
  if (params.limit) search.set("limit", String(params.limit));
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export const workTimelineApi = {
  get: (companyId: string, params: WorkTimelineParams = {}) =>
    api.get<WorkTimelineResult>(`/companies/${companyId}/timeline${query(params)}`),
};
