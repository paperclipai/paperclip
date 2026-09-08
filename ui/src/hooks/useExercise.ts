import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export type ActivityType =
  | "running"
  | "walking"
  | "cycling"
  | "swimming"
  | "strength"
  | "yoga"
  | "hiit"
  | "stretching"
  | "other";

export type IntensityLevel = "light" | "moderate" | "vigorous";

export interface ExerciseLog {
  id: string;
  companyId: string;
  userId: string;
  exerciseDate: string;
  activityType: ActivityType;
  durationMinutes: number;
  intensityLevel: IntensityLevel | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExerciseHistoryResponse {
  from: string;
  to: string;
  logs: ExerciseLog[];
}

export function buildExerciseHistoryUrl(
  companyId: string,
  from: string,
  to: string,
): string {
  return `/api/exercise?companyId=${encodeURIComponent(companyId)}&from=${from}&to=${to}`;
}

export function useExerciseHistory(
  companyId: string | undefined,
  from: string,
  to: string,
) {
  return useQuery<ExerciseHistoryResponse>({
    queryKey: ["exercise-history", companyId, from, to],
    queryFn: async () => {
      const res = await fetch(
        `/api/exercise?companyId=${encodeURIComponent(companyId!)}&from=${from}&to=${to}`,
        { credentials: "include", headers: { Accept: "application/json" } },
      );
      if (!res.ok) {
        const payload = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to load exercise history (${res.status})`);
      }
      return res.json() as Promise<ExerciseHistoryResponse>;
    },
    enabled: !!companyId,
    staleTime: 5 * 60 * 1000,
  });
}

export interface LogExerciseInput {
  companyId: string;
  exerciseDate: string;
  activityType: ActivityType;
  durationMinutes: number;
  intensityLevel?: IntensityLevel | null;
  notes?: string | null;
}

export function useLogExercise() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: LogExerciseInput): Promise<ExerciseLog> => {
      const res = await fetch("/api/exercise", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to log exercise (${res.status})`);
      }
      return res.json() as Promise<ExerciseLog>;
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: ["exercise-history", input.companyId] });
    },
  });
}

export function useDeleteExerciseLog() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string; companyId: string }): Promise<void> => {
      const res = await fetch(`/api/exercise/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to delete exercise log (${res.status})`);
      }
    },
    onSuccess: (_data, { companyId }) => {
      queryClient.invalidateQueries({ queryKey: ["exercise-history", companyId] });
    },
  });
}
