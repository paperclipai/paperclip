import { useContext } from "react";
import { QueryClient, QueryClientContext, useQuery } from "@tanstack/react-query";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

/** Keeps `useQuery` mountable without a provider; never fetches (query disabled). */
let detachedClient: QueryClient | null = null;
function getDetachedClient(): QueryClient {
  detachedClient ??= new QueryClient();
  return detachedClient;
}

/**
 * Areas of responsibility experimental flag (`enableResponsibilities`).
 *
 * Reads the shared experimental-settings query, so it costs nothing beyond
 * what the shell already loads. `enabled` stays false while the query is in
 * flight (no flash of gated UI); `loaded` lets route gates and the home-path
 * decision wait for the real value instead of redirecting early. When the
 * settings cannot be read, `loaded` stays false and `error` is set, so a
 * redirect shows the failure with `retry` instead of guessing the flag is off.
 *
 * Without a QueryClientProvider it resolves to the flag-off default
 * (`{ enabled: false, loaded: true }`), so shared nav components stay
 * mountable in isolation.
 */
export interface ResponsibilitiesFlag {
  enabled: boolean;
  loaded: boolean;
  /** The settings read failed and nothing is cached. */
  error: unknown;
  retry: () => void;
}

const noop = () => {};

export function useResponsibilitiesEnabled(): ResponsibilitiesFlag {
  const contextClient = useContext(QueryClientContext);
  const { data, error, refetch } = useQuery(
    {
      queryKey: queryKeys.instance.experimentalSettings,
      queryFn: () => instanceSettingsApi.getExperimental(),
      enabled: contextClient != null,
    },
    contextClient ?? getDetachedClient(),
  );
  if (!contextClient) return { enabled: false, loaded: true, error: null, retry: noop };
  return {
    enabled: data?.enableResponsibilities === true,
    loaded: data !== undefined,
    error: data === undefined ? error ?? null : null,
    retry: () => void refetch(),
  };
}
