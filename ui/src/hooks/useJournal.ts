import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface JournalEntry {
  id: string;
  companyId: string;
  userId: string;
  entryDate: string;
  title: string | null;
  body: string;
  moodScore: number | null;
  tags: string[];
  isPrivate: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface JournalResponse {
  from: string;
  to: string;
  entries: JournalEntry[];
}

export function buildJournalUrl(companyId: string, from: string, to: string): string {
  return `/api/journal?companyId=${encodeURIComponent(companyId)}&from=${from}&to=${to}`;
}

export function useJournalHistory(companyId: string | undefined, from: string, to: string) {
  return useQuery<JournalResponse>({
    queryKey: ["journal", companyId, from, to],
    queryFn: async () => {
      const res = await fetch(buildJournalUrl(companyId!, from, to), {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to load journal (${res.status})`);
      }
      return res.json() as Promise<JournalResponse>;
    },
    enabled: !!companyId,
    staleTime: 5 * 60 * 1000,
  });
}

export interface CreateJournalInput {
  companyId: string;
  entryDate: string;
  body: string;
  title?: string | null;
  moodScore?: number | null;
  tags?: string[];
  isPrivate?: boolean;
}

export function useCreateJournalEntry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateJournalInput): Promise<JournalEntry> => {
      const res = await fetch("/api/journal", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to create journal entry (${res.status})`);
      }
      return res.json() as Promise<JournalEntry>;
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: ["journal", input.companyId] });
    },
  });
}

export interface UpdateJournalInput {
  id: string;
  companyId: string;
  body?: string;
  title?: string | null;
  moodScore?: number | null;
  tags?: string[];
  isPrivate?: boolean;
}

export function useUpdateJournalEntry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, companyId: _cid, ...updates }: UpdateJournalInput): Promise<JournalEntry> => {
      const res = await fetch(`/api/journal/${encodeURIComponent(id)}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(updates),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to update journal entry (${res.status})`);
      }
      return res.json() as Promise<JournalEntry>;
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: ["journal", input.companyId] });
    },
  });
}

export function useDeleteJournalEntry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string; companyId: string }): Promise<void> => {
      const res = await fetch(`/api/journal/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to delete journal entry (${res.status})`);
      }
    },
    onSuccess: (_data, { companyId }) => {
      queryClient.invalidateQueries({ queryKey: ["journal", companyId] });
    },
  });
}
