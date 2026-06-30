import type {
  ActivityEvent,
  Workflow,
  WorkflowDetail,
  WorkflowHandoff,
  WorkflowListItem,
  WorkflowRun,
  WorkflowRunDetail,
  WorkflowSchedule,
  WorkflowInvocationResult,
} from "@paperclipai/shared";
import { activityApi } from "./activity";
import { api } from "./client";

export interface WorkflowMutationInput {
  title: string;
  description?: string | null;
  status?: string;
  workflowKey?: string | null;
  capabilities?: string[];
  runnerConfig: Record<string, unknown>;
}

export interface WorkflowInvocationInput {
  sourceRoutineRunId: string;
  invocation: {
    contractVersion: "workflow-invocation/v1";
    target: {
      workflowId?: string | null;
      workflowKey?: string | null;
      capability?: string | null;
    };
    payload:
      | { kind: "markdown"; inputMarkdown: string }
      | { kind: "json"; inputJson: Record<string, unknown> };
  };
}

export interface ResolveWorkflowHandoffInput {
  responseMarkdown?: string | null;
}

export interface WorkflowScheduleMutationInput {
  title: string;
  cronExpression: string;
  templateMarkdown: string;
  status?: string;
}

export const workflowsApi = {
  list: (companyId: string) => api.get<WorkflowListItem[]>(`/companies/${companyId}/workflows`),
  create: (companyId: string, data: WorkflowMutationInput) =>
    api.post<Workflow>(`/companies/${companyId}/workflows`, data),
  get: (id: string) => api.get<WorkflowDetail>(`/workflows/${id}`),
  update: (id: string, data: Partial<WorkflowMutationInput>) =>
    api.patch<Workflow>(`/workflows/${id}`, data),
  run: (id: string, data: { inputMarkdown: string }) =>
    api.post<WorkflowRun>(`/workflows/${id}/run`, data),
  invokeFromRoutine: (routineId: string, data: WorkflowInvocationInput) =>
    api.post<WorkflowInvocationResult>(`/routines/${routineId}/workflow-invocations`, data),
  listSchedules: (workflowId: string) => api.get<WorkflowSchedule[]>(`/workflows/${workflowId}/schedules`),
  createSchedule: (workflowId: string, data: WorkflowScheduleMutationInput) =>
    api.post<WorkflowSchedule>(`/workflows/${workflowId}/schedules`, data),
  updateSchedule: (scheduleId: string, data: Partial<WorkflowScheduleMutationInput>) =>
    api.patch<WorkflowSchedule>(`/workflow-schedules/${scheduleId}`, data),
  deleteSchedule: (scheduleId: string) =>
    api.delete<void>(`/workflow-schedules/${scheduleId}`),
  getRun: (id: string) => api.get<WorkflowRunDetail>(`/workflow-runs/${id}`),
  cancelRun: (id: string) => api.post<WorkflowRun>(`/workflow-runs/${id}/cancel`, {}),
  approveHandoff: (id: string, data?: ResolveWorkflowHandoffInput) =>
    api.post<WorkflowHandoff>(`/workflow-handoffs/${id}/approve`, data ?? {}),
  rejectHandoff: (id: string, data?: ResolveWorkflowHandoffInput) =>
    api.post<WorkflowHandoff>(`/workflow-handoffs/${id}/reject`, data ?? {}),
  respondHandoff: (id: string, data: ResolveWorkflowHandoffInput) =>
    api.post<WorkflowHandoff>(`/workflow-handoffs/${id}/respond`, data),
  activity: async (
    companyId: string,
    workflowId: string,
    related?: { runIds?: string[]; handoffIds?: string[] },
  ): Promise<ActivityEvent[]> => {
    const requests = [
      activityApi.list(companyId, { entityType: "workflow", entityId: workflowId }),
      ...(related?.runIds ?? []).map((runId) =>
        activityApi.list(companyId, { entityType: "workflow_run", entityId: runId })),
      ...(related?.handoffIds ?? []).map((handoffId) =>
        activityApi.list(companyId, { entityType: "workflow_handoff", entityId: handoffId })),
    ];
    const events = (await Promise.all(requests)).flat();
    const deduped = new Map(events.map((event) => [event.id, event]));
    return [...deduped.values()].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  },
};
