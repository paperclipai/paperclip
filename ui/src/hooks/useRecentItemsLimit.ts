import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DEFAULT_RECENT_ITEMS_LIMIT, type WorkspacePreference } from "@paperclipai/shared";
import { workspacePreferencesApi } from "@/api/workspacePreferences";
import { queryKeys } from "@/lib/queryKeys";
import { useAccountBoundMutation } from "./useAccountBoundMutation";

export function useRecentItemsLimit(userId: string | null | undefined) {
  const client = useQueryClient();
  const preference = useQuery({
    queryKey: queryKeys.workspacePreferences.mine(userId ?? null),
    queryFn: () => workspacePreferencesApi.get(),
    enabled: !!userId,
  });
  const mutation = useAccountBoundMutation({
    mutationFn: async ({ companyId, limit, owner }: { companyId: string; limit: number; owner: string }) => {
      const result = await workspacePreferencesApi.update(companyId, { recentItemsLimit: limit });
      if (result.userId !== owner) throw new Error("Your account changed. Reload your preferences and try again.");
      return result;
    },
    onSuccess: result => client.setQueryData<WorkspacePreference>(queryKeys.workspacePreferences.mine(result.userId),
      current => current ? { ...current, recentItemsLimit: result.recentItemsLimit } : result),
  });
  const loaded = !!userId && preference.isSuccess && preference.data.userId === userId;
  return {
    limit: loaded ? preference.data.recentItemsLimit ?? DEFAULT_RECENT_ITEMS_LIMIT : 0,
    loaded,
    error: preference.error ?? (mutation.variables?.owner === userId ? mutation.error : null),
    isSaving: mutation.isPending && mutation.variables?.owner === userId,
    retry: () => preference.refetch(),
    setLimit: async (companyId: string, limit: number) => {
      if (!userId) throw new Error("Sign in before changing your preferences.");
      return mutation.mutateAsync({ companyId, limit, owner: userId });
    },
  };
}
