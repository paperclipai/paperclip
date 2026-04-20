import type {
  BackgroundJob,
  BackgroundJobEvent,
  BackgroundJobRun,
  CreateBackgroundJob,
  CreateBackgroundJobRun,
  ListBackgroundJobRunsQuery,
  ListBackgroundJobsQuery,
} from "@paperclipai/shared";
import { api } from "./client";

function buildQueryString(filters?: Record<string, string | number | boolean | Date | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters ?? {})) {
    if (value === undefined) continue;
    params.set(key, value instanceof Date ? value.toISOString() : String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const backgroundJobsApi = {
  listJobs: (companyId: string, filters?: Partial<ListBackgroundJobsQuery>) =>
    api.get<BackgroundJob[]>(
      `/companies/${encodeURIComponent(companyId)}/background-jobs${buildQueryString(filters)}`,
    ),
  createJob: (companyId: string, data: CreateBackgroundJob) =>
    api.post<BackgroundJob>(`/companies/${encodeURIComponent(companyId)}/background-jobs`, data),
  listRuns: (companyId: string, filters?: Partial<ListBackgroundJobRunsQuery>) =>
    api.get<BackgroundJobRun[]>(
      `/companies/${encodeURIComponent(companyId)}/background-job-runs${buildQueryString(filters)}`,
    ),
  createRun: (companyId: string, data: CreateBackgroundJobRun) =>
    api.post<BackgroundJobRun>(`/companies/${encodeURIComponent(companyId)}/background-job-runs`, data),
  getRun: (companyId: string, runId: string) =>
    api.get<BackgroundJobRun>(
      `/companies/${encodeURIComponent(companyId)}/background-job-runs/${encodeURIComponent(runId)}`,
    ),
  listRunEvents: (companyId: string, runId: string, limit?: number) =>
    api.get<BackgroundJobEvent[]>(
      `/companies/${encodeURIComponent(companyId)}/background-job-runs/${encodeURIComponent(runId)}/events${buildQueryString({ limit })}`,
    ),
  cancelRun: (companyId: string, runId: string) =>
    api.post<BackgroundJobRun>(
      `/companies/${encodeURIComponent(companyId)}/background-job-runs/${encodeURIComponent(runId)}/cancel`,
      {},
    ),
};
