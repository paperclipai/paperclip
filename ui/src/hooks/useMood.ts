import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface MoodLog {
  id: string;
  companyId: string;
  userId: string;
  logDate: string;
  moodScore: number;
  energyLevel: number | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MoodHistoryResponse {
  from: string;
  to: string;
  logs: MoodLog[];
}

export function buildMoodHistoryUrl(companyId: string, from: string, to: string): string {
  return `/api/mood?companyId=${encodeURIComponent(companyId)}&from=${from}&to=${to}`;
}

export function useMoodHistory(companyId: string | undefined, from: string, to: string) {
  return useQuery<MoodHistoryResponse>({
    queryKey: ["mood-history", companyId, from, to],
    queryFn: async () => {
      const res = await fetch(buildMoodHistoryUrl(companyId!, from, to), {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to load mood history (${res.status})`);
      }
      return res.json() as Promise<MoodHistoryResponse>;
    },
    enabled: !!companyId,
    staleTime: 5 * 60 * 1000,
  });
}

export interface LogMoodInput {
  companyId: string;
  logDate: string;
  moodScore: number;
  energyLevel?: number | null;
  notes?: string | null;
}

export function useLogMood() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: LogMoodInput): Promise<MoodLog> => {
      const res = await fetch("/api/mood", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to log mood (${res.status})`);
      }
      return res.json() as Promise<MoodLog>;
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: ["mood-history", input.companyId] });
    },
  });
}

export function useDeleteMoodLog() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string; companyId: string }): Promise<void> => {
      const res = await fetch(`/api/mood/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to delete mood log (${res.status})`);
      }
    },
    onSuccess: (_data, { companyId }) => {
      queryClient.invalidateQueries({ queryKey: ["mood-history", companyId] });
    },
  });
}
