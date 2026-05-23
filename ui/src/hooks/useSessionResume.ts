import { useQuery } from '@tanstack/react-query';
import type { SessionResume } from '@paperclipai/shared';

interface UseSessionResumeOptions {
  companyId: string;
  agentId?: string;
  enabled?: boolean;
}

export function useSessionResume({
  companyId,
  agentId,
  enabled = true,
}: UseSessionResumeOptions) {
  return useQuery<SessionResume | null>({
    queryKey: ['sessionResume', companyId, agentId],
    queryFn: async () => {
      if (!enabled) return null;

      const params = new URLSearchParams();
      if (agentId) params.append('agentId', agentId);

      const response = await fetch(
        `/api/companies/${companyId}/sessions/resume?${params}`,
        { credentials: 'include' }
      );

      if (response.status === 404) return null;
      if (!response.ok) throw new Error('Failed to fetch session resume');

      return response.json();
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes (formerly cacheTime)
    enabled,
  });
}
