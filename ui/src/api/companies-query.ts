import { useQuery, type QueryClient } from "@tanstack/react-query";
import type { Company } from "@paperclipai/shared";
import { authApi } from "./auth";
import { companiesApi } from "./companies";
import { ApiError } from "./client";
import { queryKeys } from "../lib/queryKeys";

export type CompanyListResult = { companies: Company[]; unauthorized: boolean };

// Single source of truth for the company-list query. Every consumer reads the
// same cache entry, so they must agree on the shape — returning a bare
// `Company[]` from one and this wrapped object from another silently corrupts
// the entry and crashes whichever reads the other's shape.
//
// The entry is keyed by account. Callers therefore cannot ask for "the company
// list" without saying whose, which is the point: the previous design let a
// list fetched for one account answer a question about another, and every
// consumer had to defend against that individually.
export function companyListQueryOptions(userId: string | null) {
  return {
    queryKey: queryKeys.companies.list(userId),
    queryFn: async (): Promise<CompanyListResult> => {
      // Request coalescing keys on the path alone, so it would happily answer a
      // fetch for this account with a `/companies` request issued under the
      // previous one — putting the wrong account's list in an account-keyed
      // entry. Coalescing has nothing to offer here anyway: React Query already
      // dedupes concurrent fetches within a key, and *across* keys the accounts
      // differ by construction, which is exactly when sharing is wrong.
      companiesApi.detachInflightList();
      try {
        return { companies: await companiesApi.list(), unauthorized: false };
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          return { companies: [], unauthorized: true };
        }
        throw err;
      }
    },
    retry: false,
  } as const;
}

const sessionQueryOptions = {
  queryKey: queryKeys.auth.session,
  queryFn: () => authApi.getSession(),
  retry: false,
} as const;

/**
 * The signed-in account, as the cache currently understands it.
 *
 * `settled` is false until the session query has an answer. Fetching the list
 * before then would key it to the wrong account and force a second request when
 * the session lands, so callers hold instead.
 */
export function useAccountIdentity(): { userId: string | null; settled: boolean } {
  const { data: session, isPending } = useQuery(sessionQueryOptions);
  return { userId: session?.user.id ?? null, settled: !isPending };
}

/**
 * Observe the company list for the account signed in now.
 *
 * Pass `enabled: false` to hold for a caller's own reasons; the session gate is
 * applied on top of it either way.
 */
export function useCompanyListQuery(
  options: { enabled?: boolean; staleTime?: number; retry?: number | boolean } = {},
) {
  const { userId, settled } = useAccountIdentity();
  const query = useQuery<CompanyListResult>({
    ...companyListQueryOptions(userId),
    ...options,
    enabled: settled && (options.enabled ?? true),
  });

  // While the account is unknown this query is disabled, and a disabled query
  // reports `isLoading: false` with `data: undefined` — which consumers default
  // to an empty list and read as "asked, and owns nothing". That is the
  // destructive reading: `shouldClearStoredCompanySelection` would throw away
  // the customer's stored company on every cold boot, before the session had
  // even landed.
  //
  // Waiting for the account is part of getting the list, so it is reported as
  // part of getting the list. Consumers gate on these two, and both must mean
  // "no answer yet" for the whole window in which there is no answer.
  const waitingForAccount = !settled && (options.enabled ?? true);
  return {
    ...query,
    isLoading: query.isLoading || waitingForAccount,
    isFetching: query.isFetching || waitingForAccount,
  };
}

/**
 * Read the account identity the cache holds without subscribing to it. For
 * imperative paths (`fetchQuery`, `invalidateQueries`) that need the key.
 */
export function currentAccountUserId(queryClient: QueryClient): string | null {
  const session = queryClient.getQueryData<Awaited<ReturnType<typeof authApi.getSession>>>(
    queryKeys.auth.session,
  );
  return session?.user.id ?? null;
}

/** Fetch the company list for the account signed in now, ignoring what is cached. */
export async function fetchCompanyListForCurrentAccount(
  queryClient: QueryClient,
): Promise<CompanyListResult> {
  return queryClient.fetchQuery({
    ...companyListQueryOptions(currentAccountUserId(queryClient)),
    staleTime: 0,
  });
}
