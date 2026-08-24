import type { BackgroundJob } from "@paperclipai/shared";
import { api } from "./client";

export const backgroundJobsApi = {
  list: (
    companyId: string,
    opts?: { limit?: number; offset?: number; status?: string; jobType?: string },
  ) => {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
    if (opts?.status) params.set("status", opts.status);
    if (opts?.jobType) params.set("jobType", opts.jobType);
    const qs = params.toString();
    return api.get<BackgroundJob[]>(`/companies/${companyId}/background-jobs${qs ? `?${qs}` : ""}`);
  },

  get: (companyId: string, jobId: string) =>
    api.get<BackgroundJob>(`/companies/${companyId}/background-jobs/${jobId}`),

  create: (companyId: string, data: { jobType: string; payload: Record<string, unknown> }) =>
    api.post<BackgroundJob>(`/companies/${companyId}/background-jobs`, data),

  /** Build an SSE URL for background job events. */
  eventsUrl: (companyId: string) => `/api/companies/${companyId}/background-jobs/events`,
};

interface ActivitySearchResponse {
  jobId: string;
}

interface KeywordSearchResponse {
  query: string;
  results: Array<{
    id: string;
    type: "issue" | "document" | "activity";
    title: string;
    snippet: string | null;
    updatedAt: string;
    score: number;
  }>;
  total: number;
  semanticJobId: string | null;
}

interface AutoAssessResponse {
  jobId: string;
}

interface ExportResponse {
  jobId: string;
}

export const researchApi = {
  /** Fire-and-forget activity search (POST /research/activities). Returns 202 jobId. */
  searchActivities: (companyId: string, data: { query: string; scope?: string; limit?: number }) =>
    api.post<ActivitySearchResponse>(`/companies/${companyId}/research/activities`, data),

  /** Keyword-first search with optional async semantic upgrade (POST /research/search). */
  search: (
    companyId: string,
    data: {
      query: string;
      scope?: string;
      limit?: number;
      semanticUpgrade?: boolean;
    },
  ) => api.post<KeywordSearchResponse>(`/companies/${companyId}/research/search`, data),

  /** Fire-and-forget auto-assess (POST /research/auto-assess). Returns 202 jobId. */
  autoAssess: (
    companyId: string,
    data?: { itemIds?: string[]; limit?: number },
  ) => api.post<AutoAssessResponse>(`/companies/${companyId}/research/auto-assess`, data ?? {}),
};

export const exportsApi = {
  /** Queue a PDF export (POST /exports/pdf). Returns 202 jobId. */
  pdf: (
    companyId: string,
    data?: { title?: string; items?: Record<string, unknown>[] },
  ) => api.post<ExportResponse>(`/companies/${companyId}/exports/pdf`, data ?? {}),

  /** Queue an ICS/iCalendar export (POST /exports/ics). Returns 202 jobId. */
  ics: (
    companyId: string,
    data: {
      title?: string;
      events: Array<{
        title: string;
        start?: string;
        end?: string;
        location?: string;
        description?: string;
      }>;
    },
  ) => api.post<ExportResponse>(`/companies/${companyId}/exports/ics`, data),
};