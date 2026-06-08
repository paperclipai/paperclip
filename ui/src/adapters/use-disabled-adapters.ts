import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { adaptersApi } from "@/api/adapters";
import { setDisabledAdapterTypes } from "@/adapters/disabled-store";
import { syncExternalAdapters } from "@/adapters/registry";
import { queryKeys } from "@/lib/queryKeys";
import { useAuthedDataEnabled } from "@/hooks/useAuthedDataEnabled";

/**
 * Fetch adapters and keep the disabled-adapter store + UI adapter registry
 * in sync with the server.
 *
 * - Registers external adapter types in the UI registry so they appear in
 *   dropdowns (done eagerly during render — idempotent, no React state).
 * - Syncs the disabled-adapter store for non-React consumers (useEffect).
 *
 * Returns a reactive Set of disabled types for use as useMemo dependencies.
 * Call this at the top of any component that renders adapter menus.
 */
export function useDisabledAdaptersSync(): Set<string> {
  const { data: adapters } = useQuery({
    queryKey: queryKeys.adapters.all,
    queryFn: () => adaptersApi.list(),
    staleTime: 5 * 60 * 1000,
    // Don't fetch adapters until we're authenticated (or in local_trusted mode).
    // Keeps the unauthenticated /auth page from firing authed /api/adapters calls.
    enabled: useAuthedDataEnabled(),
  });

  // Eagerly register external adapter types in the UI registry so that
  // consumers calling listUIAdapters() in the same render cycle see them.
  // This is idempotent — already-registered types are skipped.
  if (adapters) {
    syncExternalAdapters(
      adapters
        .filter((a) => a.source === "external")
        .map((a) => ({
          type: a.type,
          label: a.label,
          disabled: a.disabled,
          overrideDisabled: a.overridePaused,
        })),
    );
  }

  // Sync the disabled set to the global store for non-React code
  useEffect(() => {
    if (!adapters) return;
    setDisabledAdapterTypes(
      adapters.filter((a) => a.disabled).map((a) => a.type),
    );
  }, [adapters]);

  return useMemo(
    () => new Set(adapters?.filter((a) => a.disabled).map((a) => a.type) ?? []),
    [adapters],
  );
}
