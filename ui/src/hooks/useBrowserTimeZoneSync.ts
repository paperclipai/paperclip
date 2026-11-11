import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isValidIanaTimeZone, type WorkspacePreference } from "@paperclipai/shared";
import { workspacePreferencesApi } from "@/api/workspacePreferences";
import { queryKeys } from "@/lib/queryKeys";

// One attempt per account and zone for this page load; the sync is best-effort.
const attempted = new Set<string>();

export function browserTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && isValidIanaTimeZone(zone) ? zone : null;
  } catch {
    return null;
  }
}

/** Saves the browser's time zone to the signed-in person's preferences so chat
 * agents read "nine in the morning" or "today" in that person's zone. */
export function useBrowserTimeZoneSync(companyId: string | null | undefined, userId: string | null) {
  const client = useQueryClient();
  const preference = useQuery({
    queryKey: queryKeys.workspacePreferences.mine(userId),
    queryFn: () => workspacePreferencesApi.get(),
    enabled: !!userId,
  });
  const savedZone = preference.isSuccess && preference.data.userId === userId ? preference.data.timeZone ?? null : undefined;
  useEffect(() => {
    if (!companyId || !userId || savedZone === undefined) return;
    const zone = browserTimeZone();
    if (!zone || zone === savedZone) return;
    const key = `${userId}\n${zone}`;
    if (attempted.has(key)) return;
    attempted.add(key);
    workspacePreferencesApi.update(companyId, { timeZone: zone })
      .then(result => {
        if (result.userId !== userId) return;
        // Merge only the zone: a newer workspace-choice response may already be cached.
        client.setQueryData<WorkspacePreference>(queryKeys.workspacePreferences.mine(userId),
          current => current && current.userId === userId ? { ...current, timeZone: result.timeZone } : current);
      })
      .catch(() => {
        // Best-effort: the agent falls back to asking or naming its assumption.
      });
  }, [client, companyId, userId, savedZone]);
}

export function resetBrowserTimeZoneSyncForTests() {
  attempted.clear();
}
