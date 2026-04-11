import type {
  ActivityEvent,
  Routine,
  RoutineDetail,
  RoutineListItem,
  RoutineRun,
  RoutineRunSummary,
  RoutineTrigger,
  RoutineTriggerSecretMaterial,
} from "@paperclipai/shared";
import { activityApi } from "./activity";
import { api } from "./client";

export interface RoutineTriggerResponse {
  trigger: RoutineTrigger;
  secretMaterial: RoutineTriggerSecretMaterial | null;
}

export interface RotateRoutineTriggerResponse {
  trigger: RoutineTrigger;
  secretMaterial: RoutineTriggerSecretMaterial;
}

export const routinesApi = {
  list: (companyId: string) => api.get<RoutineListItem[]>(`/companies/${companyId}/routines`),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Routine>(`/companies/${companyId}/routines`, data),
  get: (id: string) => api.get<RoutineDetail>(`/routines/${id}`),
  update: (id: string, data: Record<string, unknown>) => api.patch<Routine>(`/routines/${id}`, data),
  delete: (id: string) => api.delete<void>(`/routines/${id}`),
  listRuns: (id: string, limit: number = 50) => api.get<RoutineRunSummary[]>(`/routines/${id}/runs?limit=${limit}`),
  createTrigger: (id: string, data: Record<string, unknown>) =>
    api.post<RoutineTriggerResponse>(`/routines/${id}/triggers`, data),
  updateTrigger: (id: string, data: Record<string, unknown>) =>
    api.patch<RoutineTrigger>(`/routine-triggers/${id}`, data),
  deleteTrigger: (id: string) => api.delete<void>(`/routine-triggers/${id}`),
  rotateTriggerSecret: (id: string) =>
    api.post<RotateRoutineTriggerResponse>(`/routine-triggers/${id}/rotate-secret`, {}),
  run: (id: string, data?: Record<string, unknown>) =>
    api.post<RoutineRun>(`/routines/${id}/run`, data ?? {}),
  activity: async (
    companyId: string,
    routineId: string,
    related?: { triggerIds?: string[]; runIds?: string[] },
  ) => {
    const requests = [
      activityApi.list(companyId, { entityType: "routine", entityId: routineId }),
      ...(related?.triggerIds ?? []).map((triggerId) =>
        activityApi.list(companyId, { entityType: "routine_trigger", entityId: triggerId })),
      ...(related?.runIds ?? []).map((runId) =>
        activityApi.list(companyId, { entityType: "routine_run", entityId: runId })),
    ];
    const events = (await Promise.all(requests)).flat();
    const deduped = new Map(events.map((event) => [event.id, event]));
    return [...deduped.values()].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  },
};
