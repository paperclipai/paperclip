import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface NutritionLog {
  id: string;
  companyId: string;
  userId: string;
  logDate: string;
  waterMl: number;
  calories: number | null;
  proteinG: number | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NutritionHistoryResponse {
  from: string;
  to: string;
  logs: NutritionLog[];
}

export function buildNutritionHistoryUrl(companyId: string, from: string, to: string): string {
  return `/api/nutrition?companyId=${encodeURIComponent(companyId)}&from=${from}&to=${to}`;
}

export function useNutritionHistory(companyId: string | undefined, from: string, to: string) {
  return useQuery<NutritionHistoryResponse>({
    queryKey: ["nutrition-history", companyId, from, to],
    queryFn: async () => {
      const res = await fetch(buildNutritionHistoryUrl(companyId!, from, to), {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to load nutrition history (${res.status})`);
      }
      return res.json() as Promise<NutritionHistoryResponse>;
    },
    enabled: !!companyId,
    staleTime: 5 * 60 * 1000,
  });
}

export interface LogNutritionInput {
  companyId: string;
  logDate: string;
  waterMl: number;
  calories?: number | null;
  proteinG?: number | null;
  notes?: string | null;
}

export function useLogNutrition() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: LogNutritionInput): Promise<NutritionLog> => {
      const res = await fetch("/api/nutrition", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to log nutrition (${res.status})`);
      }
      return res.json() as Promise<NutritionLog>;
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: ["nutrition-history", input.companyId] });
    },
  });
}

export function useDeleteNutritionLog() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string; companyId: string }): Promise<void> => {
      const res = await fetch(`/api/nutrition/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to delete nutrition log (${res.status})`);
      }
    },
    onSuccess: (_data, { companyId }) => {
      queryClient.invalidateQueries({ queryKey: ["nutrition-history", companyId] });
    },
  });
}
