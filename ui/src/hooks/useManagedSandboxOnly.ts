import { useQuery } from "@tanstack/react-query";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Reads the instance managed-sandbox-only policy (`enableManagedSandboxOnly`).
 *
 * When the policy is on, every agent runs in the platform-managed environment
 * and the local environment is hidden. A host filesystem path, a folder picker,
 * or an execution-engine choice has no meaning on such an instance, so the UI
 * must not render one. Callers that already read the experimental settings keep
 * their own read; this hook exists for the components that do not.
 *
 * `loaded` reports whether the settings query has settled. Gates that redirect
 * or that would otherwise flash a path must wait for it.
 */
export function useManagedSandboxOnly() {
  const query = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });

  return {
    enabled: query.data?.enableManagedSandboxOnly === true,
    loaded: query.isFetched,
  };
}
