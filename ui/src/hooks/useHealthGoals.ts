import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";

export interface HealthGoal {
  id: string;
  companyId: string;
  userId: string;
  goalType: string;
  targetValue: number;
  unit: string;
  label: string;
  isActive: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export function buildHealthGoalsUrl(companyId: string): string {
  return `/health/goals?companyId=${encodeURIComponent(companyId)}`;
}

export function useHealthGoals(companyId: string) {
  return useQuery({
    queryKey: ["health-goals", companyId],
    queryFn: () => api.get<{ goals: HealthGoal[] }>(buildHealthGoalsUrl(companyId)),
    enabled: !!companyId,
    select: (data) => data.goals,
  });
}

export function useUpsertHealthGoal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      companyId: string;
      goalType: string;
      targetValue: number;
      unit: string;
      label: string;
      notes?: string;
    }) => api.post<HealthGoal>("/health/goals", body),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["health-goals", variables.companyId] });
    },
  });
}

export function useUpdateHealthGoal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      companyId,
      ...body
    }: {
      id: string;
      companyId: string;
      targetValue?: number;
      unit?: string;
      label?: string;
      notes?: string | null;
    }) => api.patch<HealthGoal>(`/health/goals/${id}`, body),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["health-goals", variables.companyId] });
    },
  });
}

export function useDeleteHealthGoal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string; companyId: string }) =>
      api.delete<void>(`/health/goals/${id}`),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["health-goals", variables.companyId] });
    },
  });
}
