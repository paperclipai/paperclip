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
      // on serving the old value until a refetch succeeds, and several of these
      // queries set `retry: false`, so a single failed request is enough to
      // leave the previous account's data readable for the whole of the *next*
      // account's session.
      //
      // The company list is no longer the example: it is keyed by account, so
      // the next account reads a different entry regardless of what happens
      // here. Everything else still is — the board-access gate, per-company
      // details and stats, and every account-scoped key added since — which is
      // why this sweeps by predicate rather than naming the keys it knows.
      //
      // `resetQueries` rather than `removeQueries`: removal empties the cache
      // but does not notify the observers already subscribed to those entries,
      // so a mounted `useQuery` keeps returning its last result until some
      // unrelated re-render happens to rebuild the query. That is not a corner
      // case here — CompanyProvider sits above the router and stays mounted
      // across the whole sign-out/sign-in cycle. Reset notifies them, so the
      // old data is gone from the cache *and* from everything reading it.
      //
      // Measured against query-core 5.101.4 rather than reasoned about:
      // removal produced 0 notifications and left the observer holding the
      // signed-out account's session; reset produced 3 and null. The
      // consequence of the former is not just stale reads — the redirect in
      // CloudAccessGate fires on the session going empty, and it never runs.
      //
      // The opposite advice holds for a *local* reset of a key an observer is
      // still mounted against. Reset rewinds the update counters
      // `isFetchedAfterMount` derives from while that observer keeps its
      // bind-time baseline, so the flag can never read true again and anything
      // gated on it withholds forever. `AppsConnect` is the consumer to check
      // against: it gates its render on that flag for two queries.
      //
      // Sign-out is not that case. It resets the session too, so `AppsConnect`
      // — which sits behind a route — unmounts on the redirect and remounts
      // with a fresh baseline.
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
