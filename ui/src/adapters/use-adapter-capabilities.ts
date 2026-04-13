import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { adaptersApi, type AdapterCapabilities } from "@/api/adapters";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Returns a lookup function that resolves adapter capabilities by type.
 *
 * Capabilities are fetched from the server adapter listing API and cached
 * via react-query. When the data is not yet loaded, the lookup returns
 * a conservative default (all capabilities false).
 */
export function useAdapterCapabilities(): (type: string) => AdapterCapabilities {
  const { data: adapters } = useQuery({
    queryKey: queryKeys.adapters.all,
    queryFn: () => adaptersApi.list(),
    staleTime: 5 * 60 * 1000,
  });

  const capMap = useMemo(() => {
    const map = new Map<string, AdapterCapabilities>();
    if (adapters) {
      for (const a of adapters) {
        map.set(a.type, a.capabilities);
      }
    }
    return map;
  }, [adapters]);

  return (type: string): AdapterCapabilities =>
    capMap.get(type) ?? {
      supportsInstructionsBundle: false,
      supportsSkills: false,
      supportsLocalAgentJwt: false,
      requiresMaterializedRuntimeSkills: false,
    };
}
