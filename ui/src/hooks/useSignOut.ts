import { useMutation, useQueryClient } from "@tanstack/react-query";
import { authApi } from "@/api/auth";
import { navigateTopLevel } from "@/lib/browserNavigation";
import { queryKeys } from "@/lib/queryKeys";
import { useCloudInstance } from "./useCloudInstance";

const CLOUD_SIGN_OUT_PATH = "/cloud/logout";

interface UseSignOutOptions {
  onSignedOut?: () => void;
}

/**
 * Owns the app-wide sign-out decision.
 *
 * Cloud-managed tenants must enter the harness-owned logout sequence without
 * first clearing the tenant session. Authenticated self-hosted instances keep
 * the local API flow and invalidate the auth-dependent caches afterward.
 */
export function useSignOut({ onSignedOut }: UseSignOutOptions = {}) {
  const cloud = useCloudInstance();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      if (cloud) {
        onSignedOut?.();
        navigateTopLevel(CLOUD_SIGN_OUT_PATH);
        return "cloud" as const;
      }

      await authApi.signOut();
      return "self-hosted" as const;
    },
    onSuccess: async (target) => {
      if (target === "cloud") return;

      onSignedOut?.();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.auth.session }),
        queryClient.invalidateQueries({ queryKey: queryKeys.health }),
      ]);
    },
  });
}
