import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { OctagonX } from "lucide-react";
import { instanceSettingsApi } from "../api/instanceSettings";
import { accessApi } from "../api/access";
import { queryKeys } from "../lib/queryKeys";

function formatTimestamp(value: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString();
}

export function SystemPauseBanner() {
  const queryClient = useQueryClient();
  const { data: boardAccess } = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
  });
  const { data } = useQuery({
    queryKey: queryKeys.instance.adminStatus,
    queryFn: () => instanceSettingsApi.getAdminStatus(),
    retry: false,
    refetchInterval: 30_000,
    enabled: !!boardAccess?.isInstanceAdmin,
  });

  const unpause = useMutation({
    mutationFn: () => instanceSettingsApi.adminUnpause(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.instance.adminStatus });
    },
  });

  if (!boardAccess?.isInstanceAdmin || !data?.paused) return null;

  const since = formatTimestamp(data.pausedAt);

  return (
    <div className="border-b border-red-300/60 bg-red-50 text-red-950 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-100">
      <div className="flex flex-col gap-2 px-3 py-2 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.18em]">
            <OctagonX className="h-3.5 w-3.5 shrink-0" />
            <span>System Paused</span>
          </div>
          <p className="mt-0.5 text-sm">
            Agent run enqueuing is blocked.
            {data.pauseReason ? ` Reason: ${data.pauseReason}.` : ""}
            {since ? ` Paused since ${since}.` : ""}
          </p>
        </div>
        <button
          type="button"
          disabled={unpause.isPending}
          onClick={() => unpause.mutate()}
          className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-red-300/70 bg-white/70 px-3 py-1.5 text-xs font-semibold text-red-900 shadow-sm transition-colors hover:bg-white disabled:opacity-50 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-100 dark:hover:bg-red-500/20"
        >
          {unpause.isPending ? "Resuming…" : "Resume System"}
        </button>
      </div>
    </div>
  );
}
