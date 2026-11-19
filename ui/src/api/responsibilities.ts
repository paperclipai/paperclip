import type {
  CreateResponsibility,
  CreateResponsibilityArea,
  DelegateResponsibility,
  LinkResponsibility,
  Responsibility,
  ResponsibilityArea,
  ResponsibilityAutomationOverview,
  ResponsibilityDelegationResult,
  ResponsibilityDetail,
  ResponsibilityLink,
  ResponsibilityLinkLookupResult,
  ResponsibilityOverview,
  ResponsibilityStatusReportState,
  ResponsibilityStatusReportsOverview,
  ResponsibilitySummary,
  ResponsibilityWithRollup,
  UpdateResponsibility,
  UpdateResponsibilityArea,
  WriteResponsibilityStatusReport,
} from "@paperclipai/shared";
import { api } from "./client";

export interface ResponsibilityOverviewFilters {
  /** Defaults to the acting user on the server. */
  ownerUserId?: string | null;
  /** Include responsibilities the owner has let go. */
  includeLetGo?: boolean;
}

export interface ResponsibilityLinkResult {
  link: ResponsibilityLink;
}

function overviewSearch(filters?: ResponsibilityOverviewFilters): string {
  const params = new URLSearchParams();
  if (filters?.ownerUserId) params.set("ownerUserId", filters.ownerUserId);
  if (filters?.includeLetGo) params.set("includeLetGo", "true");
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** Responsibilities (experimental, `enableResponsibilities`). */
export const responsibilitiesApi = {
  overview: (companyId: string, filters?: ResponsibilityOverviewFilters) =>
    api.get<ResponsibilityOverview>(
      `/companies/${encodeURIComponent(companyId)}/responsibilities${overviewSearch(filters)}`,
    ),
  /** Where everything the owner (default: the acting user) holds stands, as a paragraph. */
  companySummary: (companyId: string, filters?: Pick<ResponsibilityOverviewFilters, "ownerUserId">) =>
    api.get<ResponsibilitySummary>(
      `/companies/${encodeURIComponent(companyId)}/responsibilities/summary${
        filters?.ownerUserId ? `?${new URLSearchParams({ ownerUserId: filters.ownerUserId })}` : ""
      }`,
    ),
  /** How automated everything the owner (default: the acting user) holds is, with what could become routines. */
  automation: (companyId: string, filters?: Pick<ResponsibilityOverviewFilters, "ownerUserId">) =>
    api.get<ResponsibilityAutomationOverview>(
      `/companies/${encodeURIComponent(companyId)}/responsibilities/automation${
        filters?.ownerUserId ? `?${new URLSearchParams({ ownerUserId: filters.ownerUserId })}` : ""
      }`,
    ),
  /** What in the work is affecting one responsibility's number, as a paragraph. */
  summary: (id: string) => api.get<ResponsibilitySummary>(`/responsibilities/${encodeURIComponent(id)}/summary`),
  create: (companyId: string, data: CreateResponsibility) =>
    api.post<ResponsibilityWithRollup>(`/companies/${encodeURIComponent(companyId)}/responsibilities`, data),
  get: (id: string) => api.get<ResponsibilityDetail>(`/responsibilities/${encodeURIComponent(id)}`),
  update: (id: string, data: UpdateResponsibility) =>
    api.patch<ResponsibilityWithRollup>(`/responsibilities/${encodeURIComponent(id)}`, data),
  remove: (id: string) => api.delete<Responsibility>(`/responsibilities/${encodeURIComponent(id)}`),
  link: (id: string, target: LinkResponsibility) =>
    api.post<ResponsibilityLinkResult>(`/responsibilities/${encodeURIComponent(id)}/links`, target),
  unlink: (id: string, linkId: string) =>
    api.delete<ResponsibilityLink>(
      `/responsibilities/${encodeURIComponent(id)}/links/${encodeURIComponent(linkId)}`,
    ),
  /** The responsibilities a routine is under, directly or through its project. */
  lookupRoutineLinks: (companyId: string, routineId: string) =>
    api.get<ResponsibilityLinkLookupResult>(
      `/companies/${encodeURIComponent(companyId)}/responsibility-links/lookup?${new URLSearchParams({ routineId })}`,
    ),
  delegate: (id: string, data: DelegateResponsibility) =>
    api.post<ResponsibilityDelegationResult>(`/responsibilities/${encodeURIComponent(id)}/delegate`, data),
  /** The agent-written status of every active responsibility the owner (default: the acting user) holds, in one read. */
  statusReports: (companyId: string, filters?: Pick<ResponsibilityOverviewFilters, "ownerUserId">) =>
    api.get<ResponsibilityStatusReportsOverview>(
      `/companies/${encodeURIComponent(companyId)}/responsibilities/status-reports${
        filters?.ownerUserId ? `?${new URLSearchParams({ ownerUserId: filters.ownerUserId })}` : ""
      }`,
    ),
  /** One responsibility's agent-written status: current report, reporter, whether an update is pending, recent history. */
  statusReport: (id: string) =>
    api.get<ResponsibilityStatusReportState>(`/responsibilities/${encodeURIComponent(id)}/status-report`),
  /** A person writes or corrects the status; the record says a person wrote it. */
  writeStatusReport: (id: string, data: WriteResponsibilityStatusReport) =>
    api.post<ResponsibilityStatusReportState>(`/responsibilities/${encodeURIComponent(id)}/status-report`, data),
  /** The owner asks the reporting agent for an update (opens a small task for it). */
  requestStatusUpdate: (id: string) =>
    api.post<ResponsibilityStatusReportState>(`/responsibilities/${encodeURIComponent(id)}/status-report/request`, {}),
};

/**
 * Areas: broad things a company cares about, with no owner. Any board user
 * manages them. Creating one whose title already exists returns that area.
 */
export const responsibilityAreasApi = {
  list: (companyId: string, options?: { includeArchived?: boolean }) =>
    api.get<ResponsibilityArea[]>(
      `/companies/${encodeURIComponent(companyId)}/responsibility-areas${options?.includeArchived ? "?includeArchived=true" : ""}`,
    ),
  create: (companyId: string, data: CreateResponsibilityArea) =>
    api.post<ResponsibilityArea>(`/companies/${encodeURIComponent(companyId)}/responsibility-areas`, data),
  update: (id: string, data: UpdateResponsibilityArea) =>
    api.patch<ResponsibilityArea>(`/responsibility-areas/${encodeURIComponent(id)}`, data),
};
