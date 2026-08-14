import { useMutation, useQueryClient } from "@tanstack/react-query";
import { authApi } from "@/api/auth";
import { navigateTopLevel } from "@/lib/browserNavigation";
import { queryKeys } from "@/lib/queryKeys";
import { useCloudInstance } from "./useCloudInstance";

const CLOUD_SIGN_OUT_PATH = "/cloud/logout";

/**
 * Query-key roots that describe the *instance* rather than the account that was
 * signed in, and so are allowed to outlive a sign-out.
 *
 * `health` is the only one. It carries deployment mode, bootstrap state and
 * Cloud metadata — nothing account-scoped — and `useCloudInstance` observes it
 * with `enabled: false`, deliberately leaving the fetch to CloudAccessGate.
 * Dropping the entry would strand every such observer on `null` until the gate
 * happened to refetch, flipping Cloud instances into their self-hosted
 * rendering mid-sign-out. It is refreshed in place instead.
 *
 * Everything *not* listed here is treated as account-scoped and cleared. That
 * direction is the point: a query key added later is account-scoped unless
 * someone deliberately says otherwise, so forgetting this file fails closed.
 */
const INSTANCE_SCOPED_QUERY_ROOTS: readonly unknown[] = [queryKeys.health[0]];

export function isAccountScopedQueryKey(queryKey: readonly unknown[]): boolean {
  return !INSTANCE_SCOPED_QUERY_ROOTS.includes(queryKey[0]);
}

interface UseSignOutOptions {
  onSignedOut?: () => void;
}

/**
 * Owns the app-wide sign-out decision.
 *
 * Cloud-managed tenants must enter the harness-owned logout sequence without
 * first clearing the tenant session; that path is a top-level navigation, so
 * the document reload it triggers builds a new QueryClient and there is nothing
 * left here to clear. Authenticated self-hosted instances keep the local API
 * flow and drop the account-scoped caches afterward.
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

      // Drop every account-scoped cache entry, rather than invalidating a
      // couple of them. `invalidateQueries` only marks an entry stale and goes
      // on serving the old value until a refetch succeeds — and the companies
      // query sets `retry: false`, so a single failed request is enough to
      // leave the previous account's company list readable for the whole of
      // the *next* account's session. Consumers that read a non-empty list as
      // authoritative (company auto-selection, the invite-landing "already a
      // member" check, the board-access gate) would then act on it.
      //
      // `resetQueries` rather than `removeQueries`: removal empties the cache
      // but does not notify the observers already subscribed to those entries,
      // so a mounted `useQuery` keeps returning its last result until some
      // unrelated re-render happens to rebuild the query. That is not a corner
      // case here — CompanyProvider sits above the router and stays mounted
      // across the whole sign-out/sign-in cycle. Reset notifies them, so the
      // old data is gone from the cache *and* from everything reading it.
      //
      // Not awaited: the refetches this kicks off are expected to 401 now that
      // the session is gone, and the sign-out button should not sit pending
      // while they fail.
      void queryClient.resetQueries({
        predicate: (query) => isAccountScopedQueryKey(query.queryKey),
      });

      // Instance-scoped, so refreshed in place rather than dropped — see
      // INSTANCE_SCOPED_QUERY_ROOTS.
      await queryClient.invalidateQueries({ queryKey: queryKeys.health });
    },
  });
}
