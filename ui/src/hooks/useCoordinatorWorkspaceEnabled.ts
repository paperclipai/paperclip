import { localizeUiError, describeUiError } from "@/lib/localized-ui-error";
import { useContext } from "react";
import { QueryClient, QueryClientContext, useQuery } from "@tanstack/react-query";
import { useAccountBoundMutation } from "./useAccountBoundMutation";
import { authApi } from "@/api/auth";
import { healthApi } from "@/api/health";
import { workspacePreferencesApi } from "@/api/workspacePreferences";
import { queryKeys } from "@/lib/queryKeys";

let detachedClient: QueryClient | null = null;
const getDetachedClient = () => detachedClient ??= new QueryClient();

export function useCoordinatorWorkspaceEnabled() {
  const contextClient = useContext(QueryClientContext);
  const client = contextClient ?? getDetachedClient();
  const session = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: contextClient != null,
  }, client);
  const sessionUserId = session.data?.user?.id ?? session.data?.session?.userId ?? null;
  const health = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    enabled: contextClient != null && session.isSuccess && !sessionUserId,
  }, client);
  const userId = session.isSuccess
    ? sessionUserId ?? (health.isSuccess && health.data.deploymentMode === "local_trusted" ? "local-board" : null)
    : null;
  const preference = useQuery({
    queryKey: queryKeys.workspacePreferences.mine(userId),
    queryFn: () => workspacePreferencesApi.get(),
    enabled: contextClient != null && !!userId,
  }, client);
  const mutation = useAccountBoundMutation({
    mutationFn: async ({ companyId, enabled, owner }: { companyId: string; enabled: boolean; owner: string }) => {
      const result = await workspacePreferencesApi.update(companyId, { coordinatorWorkspaceEnabled: enabled });
      if (result.userId !== owner) throw localizeUiError(new Error("Your account changed. Reload your workspace preference and try again."), { key: "final-components-b:error.Your_account_changed_Reload_your_workspace_preference_and_try_again_ff6b10" });
      return result;
    },
    onSuccess: (result) => {
      // Only a response in its original verified account may update the cache.
      client.setQueryData(queryKeys.workspacePreferences.mine(result.userId), result);
    },
  }, client);
  const classicWorkspaceEnabled = !!userId && preference.isSuccess
    && preference.data.userId === userId && preference.data.coordinatorWorkspaceEnabled === false;
  const identityLoaded = session.isFetched && (!!sessionUserId || session.isError || health.isFetched);
  return {
    enabled: !!contextClient && !classicWorkspaceEnabled,
    loaded: !contextClient || (identityLoaded && (!userId || preference.isFetched)),
    userId,
    error: session.error ?? (!sessionUserId ? health.error : null) ?? preference.error
      ?? (mutation.variables?.owner === userId ? mutation.error : null),
    isSaving: mutation.isPending && mutation.variables?.owner === userId,
    setEnabled: async (companyId: string, enabled: boolean) => {
      if (!contextClient || !userId) throw localizeUiError(new Error("Sign in before changing your workspace."), { key: "final-components-b:error.Sign_in_before_changing_your_workspace_bd3349" });
      return mutation.mutateAsync({ companyId, enabled, owner: userId });
    },
    retry: async () => {
      mutation.reset();
      if (session.isError) return session.refetch();
      if (!sessionUserId && health.isError) return health.refetch();
      if (userId) return preference.refetch();
    },
  };
}
