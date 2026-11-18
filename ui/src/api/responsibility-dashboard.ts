import type {
  AcceptedDashboardChangeSet,
  ProposeDashboardChangesInteraction,
  ResponsibilityDashboardMode,
  ResponsibilityDashboardState,
  ResponsibilityDashboardVersionList,
  RestoredDashboardVersion,
} from "@paperclipai/shared";
import { api } from "./client";

function ownerQuery(ownerUserId: string) {
  return `?ownerUserId=${encodeURIComponent(ownerUserId)}`;
}

/** A person's Dashboard, made and changed by talking to an agent, with saved versions (experimental `enableResponsibilities`). */
export const responsibilityDashboardApi = {
  /** Where the dashboard conversation stands, the agent a new one would be with, and the latest applied change. */
  state: (companyId: string, ownerUserId: string) =>
    api.get<ResponsibilityDashboardState>(`/companies/${encodeURIComponent(companyId)}/responsibility-dashboard${ownerQuery(ownerUserId)}`),
  /** Opens the conversation in `mode`, or returns the one already open. */
  start: (companyId: string, body: { mode: ResponsibilityDashboardMode; ownerUserId: string; agentId?: string }) =>
    api.post<ResponsibilityDashboardState>(`/companies/${encodeURIComponent(companyId)}/responsibility-dashboard/conversation`, body),
  /** Saved versions, newest first; saves the dashboard as it is first when it changed by hand. */
  versions: (companyId: string, ownerUserId: string) =>
    api.get<ResponsibilityDashboardVersionList>(
      `/companies/${encodeURIComponent(companyId)}/responsibility-dashboard/versions${ownerQuery(ownerUserId)}`,
    ),
  restore: (versionId: string) =>
    api.post<RestoredDashboardVersion>(`/responsibility-dashboard-versions/${encodeURIComponent(versionId)}/restore`, {}),
  /** `keep`: indexes of the changes to apply; leave it out to apply them all. */
  accept: (issueId: string, interactionId: string, keep?: number[]) =>
    api.post<AcceptedDashboardChangeSet>(
      `/issues/${encodeURIComponent(issueId)}/dashboard-changes/${encodeURIComponent(interactionId)}/accept`,
      keep ? { keep } : {},
    ),
  decline: (issueId: string, interactionId: string) =>
    api.post<ProposeDashboardChangesInteraction>(
      `/issues/${encodeURIComponent(issueId)}/dashboard-changes/${encodeURIComponent(interactionId)}/decline`,
      {},
    ),
};
