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
 * `enabled` is the policy itself and `loaded` reports whether the settings query
 * has settled. Gate a host-path surface on `hideHostPaths`, never on `enabled`:
 * a cold cache resolves `enabled` to false for the first render, which would
 * flash the path the policy exists to hide.
 */
export function useManagedSandboxOnly() {
  const query = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });

  const enabled = query.data?.enableManagedSandboxOnly === true;
  const loaded = query.isFetched;

  return {
    enabled,
    loaded,
    /**
     * The gate for any surface that shows a host filesystem path or an
     * execution-engine choice. It fails closed while the policy is unknown, so
     * nothing renders until the query settles. After that it is exactly
     * `enabled`. A query that settles with an error counts as settled, so a
     * failed settings read does not hide these surfaces forever.
     */
    hideHostPaths: !loaded || enabled,
  };
}
