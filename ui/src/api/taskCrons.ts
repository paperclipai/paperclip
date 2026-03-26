import type { TaskCronSchedule } from "@paperclipai/shared";
import { api } from "./client";

export interface TaskCronScheduleInput {
  name: string;
  expression: string;
  timezone?: string;
  enabled?: boolean;
  issueMode?: "create_new" | "reuse_existing" | "reopen_existing";
  issueId?: string | null;
  issueTemplate?: Record<string, unknown> | null;
  payload?: Record<string, unknown> | null;
}

export const taskCronsApi = {
  listCompanySchedules: (companyId: string, projectId?: string) => {
    const suffix = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    return api.get<TaskCronSchedule[]>(`/companies/${encodeURIComponent(companyId)}/task-cron-schedules${suffix}`);
  },
  listAgentSchedules: (agentId: string, companyId?: string) => {
    const suffix = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
    return api.get<TaskCronSchedule[]>(`/agents/${encodeURIComponent(agentId)}/task-cron-schedules${suffix}`);
  },
  createAgentSchedule: (agentId: string, input: TaskCronScheduleInput, companyId?: string) => {
    const suffix = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
    return api.post<TaskCronSchedule>(`/agents/${encodeURIComponent(agentId)}/task-cron-schedules${suffix}`, input);
  },
  updateSchedule: (scheduleId: string, input: Partial<TaskCronScheduleInput>, companyId?: string) => {
    const suffix = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
    return api.patch<TaskCronSchedule>(`/task-cron-schedules/${encodeURIComponent(scheduleId)}${suffix}`, input);
  },
  deleteSchedule: (scheduleId: string, companyId?: string) => {
    const suffix = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
    return api.delete<{ ok: true }>(`/task-cron-schedules/${encodeURIComponent(scheduleId)}${suffix}`);
  },
  listIssueSchedules: (issueId: string, companyId?: string) => {
    const suffix = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
    return api.get<TaskCronSchedule[]>(`/issues/${encodeURIComponent(issueId)}/task-cron-schedules${suffix}`);
  },
  createIssueSchedule: (issueId: string, input: TaskCronScheduleInput, companyId?: string) => {
    const suffix = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
    return api.post<TaskCronSchedule>(`/issues/${encodeURIComponent(issueId)}/task-cron-schedules${suffix}`, input);
  },
  attachIssue: (scheduleId: string, issueId: string, companyId?: string) => {
    const suffix = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
    return api.post<TaskCronSchedule>(
      `/task-cron-schedules/${encodeURIComponent(scheduleId)}/attach-issue${suffix}`,
      { issueId },
    );
  },
  detachIssue: (scheduleId: string, companyId?: string) => {
    const suffix = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
    return api.post<TaskCronSchedule>(
      `/task-cron-schedules/${encodeURIComponent(scheduleId)}/detach-issue${suffix}`,
      {},
    );
  },
};
