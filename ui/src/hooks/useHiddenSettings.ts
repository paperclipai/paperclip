import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { healthApi } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Settings surfaces hidden by the hosting operator, from the app-wide health
 * query cache (keys from the shared settings-visibility registry, e.g.
 * "instance.plugins" or "instance.experimental.enableSmokeLab").
 * CloudAccessGate owns the fetch; this observer never issues its own request.
 *
 * `loaded` is false until the health response is in the cache — gates should
 * render nothing rather than flash a surface that may turn out to be hidden.
 */
export function useHiddenSettings(): { hidden: ReadonlySet<string>; loaded: boolean } {
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    enabled: false,
  });

  const data = healthQuery.data;
  return useMemo(
    () => ({ hidden: new Set(data?.hiddenSettings ?? []), loaded: data !== undefined }),
    [data],
  );
}
