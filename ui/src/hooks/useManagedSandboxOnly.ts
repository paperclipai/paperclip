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
 * `enabled` is the policy itself and `loaded` reports whether the policy is
 * actually known. Gate a host-path surface on `hideHostPaths`, never on
 * `enabled`: a cold cache resolves `enabled` to false for the first render,
 * which would flash the path the policy exists to hide.
 */
export function useManagedSandboxOnly() {
  const query = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });

  const enabled = query.data?.enableManagedSandboxOnly === true;
  // Having settings data is what tells us the policy, not the query status.
  // `isFetched` turns true once a request fails too, and a failed read leaves
  // `enabled` false — gating on it would render host paths on exactly the
  // managed-sandbox-only instance that cannot reach its settings endpoint.
  // Reading the data instead also keeps a background refetch failure harmless:
  // the last known policy is retained and stays in force.
  const loaded = query.data !== undefined;

  return {
    enabled,
    loaded,
    /**
     * The gate for any surface that shows a host filesystem path or an
     * execution-engine choice. It fails closed whenever the policy is unknown —
     * while the first read is in flight and also when that read fails — so a
     * path is never shown on the strength of a policy nobody has read. Once
     * settings are in hand it is exactly `enabled`.
     */
    hideHostPaths: !loaded || enabled,
  };
}
