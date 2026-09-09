import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface HabitDefinition {
  id: string;
  companyId: string;
  userId: string;
  name: string;
  description: string | null;
  color: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HabitCompletion {
  id: string;
  habitId: string;
  companyId: string;
  userId: string;
  completionDate: string;
  notes: string | null;
  createdAt: string;
}

export function buildHabitsUrl(companyId: string): string {
  return `/api/habits?companyId=${encodeURIComponent(companyId)}`;
}

export function buildHabitCompletionsUrl(companyId: string, from: string, to: string): string {
  return `/api/habits/completions?companyId=${encodeURIComponent(companyId)}&from=${from}&to=${to}`;
}

export function useHabits(companyId: string | undefined) {
  return useQuery<{ habits: HabitDefinition[] }>({
    queryKey: ["habits", companyId],
    queryFn: async () => {
      const res = await fetch(buildHabitsUrl(companyId!), {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to load habits (${res.status})`);
      }
      return res.json() as Promise<{ habits: HabitDefinition[] }>;
    },
    enabled: !!companyId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useHabitCompletions(
  companyId: string | undefined,
  from: string,
  to: string,
) {
  return useQuery<{ from: string; to: string; completions: HabitCompletion[] }>({
    queryKey: ["habit-completions", companyId, from, to],
    queryFn: async () => {
      const res = await fetch(buildHabitCompletionsUrl(companyId!, from, to), {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to load habit completions (${res.status})`);
      }
      return res.json() as Promise<{ from: string; to: string; completions: HabitCompletion[] }>;
    },
    enabled: !!companyId,
    staleTime: 60 * 1000,
  });
}

export function useCreateHabit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      companyId: string;
      name: string;
      description?: string | null;
      color?: string;
    }): Promise<HabitDefinition> => {
      const res = await fetch("/api/habits", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to create habit (${res.status})`);
      }
      return res.json() as Promise<HabitDefinition>;
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: ["habits", input.companyId] });
    },
  });
}

export function useCompleteHabit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      habitId,
      completionDate,
      notes,
    }: {
      habitId: string;
      completionDate: string;
      companyId: string;
      notes?: string | null;
    }): Promise<HabitCompletion> => {
      const res = await fetch(`/api/habits/${encodeURIComponent(habitId)}/complete`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ completionDate, notes }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to mark habit complete (${res.status})`);
      }
      return res.json() as Promise<HabitCompletion>;
    },
    onSuccess: (_data, { companyId }) => {
      queryClient.invalidateQueries({ queryKey: ["habit-completions", companyId] });
    },
  });
}

export function useUncompleteHabit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      habitId,
      completionDate,
    }: {
      habitId: string;
      completionDate: string;
      companyId: string;
    }): Promise<void> => {
      const res = await fetch(
        `/api/habits/${encodeURIComponent(habitId)}/complete/${encodeURIComponent(completionDate)}`,
        { method: "DELETE", credentials: "include" },
      );
      if (!res.ok && res.status !== 204) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to unmark habit (${res.status})`);
      }
    },
    onSuccess: (_data, { companyId }) => {
      queryClient.invalidateQueries({ queryKey: ["habit-completions", companyId] });
    },
  });
}

export function useArchiveHabit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string; companyId: string }): Promise<void> => {
      const res = await fetch(`/api/habits/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok && res.status !== 204) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to archive habit (${res.status})`);
      }
    },
    onSuccess: (_data, { companyId }) => {
      queryClient.invalidateQueries({ queryKey: ["habits", companyId] });
    },
  });
}
