import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BellOff, ExternalLink, ShieldCheck } from "lucide-react";
import { Link } from "@/lib/router";
import { instanceUpdatesApi } from "../api/instanceUpdates";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";

function describeBackupReason(reason: string) {
  switch (reason) {
    case "missing":
      return "pre-update backup required";
    case "stale":
      return "pre-update backup expired";
    case "target_mismatch":
      return "backup is for a different version";
    case "failed":
      return "last backup failed";
    case "external_storage_unverified":
      return "external storage acknowledgement required";
    default:
      return "backup gate pending";
  }
}

export function UpdateStatusBanner() {
  const queryClient = useQueryClient();
  const statusQuery = useQuery({
    queryKey: queryKeys.instance.updateStatus,
    queryFn: () => instanceUpdatesApi.getStatus(),
    retry: false,
    refetchInterval: 5 * 60 * 1000,
    refetchIntervalInBackground: true,
  });

  const dismissMutation = useMutation({
    mutationFn: (version: string | null | undefined) => instanceUpdatesApi.dismiss(version),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.updateStatus });
    },
  });

  if (statusQuery.error instanceof ApiError && statusQuery.error.status === 403) return null;
  if (statusQuery.error || !statusQuery.data?.banner.shouldShow) return null;

  const status = statusQuery.data;
  const needsAttention = status.banner.tone === "warn";
  const title = needsAttention ? "Paperclip Update Needs Backup" : "Paperclip Update Available";
  const backupText = status.backup.valid
    ? "pre-update backup ready"
    : describeBackupReason(status.backup.reason);

  return (
    <div
      role="alert"
      className={
        needsAttention
          ? "border-b border-amber-300/60 bg-amber-50 text-amber-950 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-100"
          : "border-b border-sky-300/60 bg-sky-50 text-sky-950 dark:border-sky-500/25 dark:bg-sky-500/10 dark:text-sky-100"
      }
    >
      <div className="flex flex-col gap-2 px-3 py-2.5 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.18em]">
            {needsAttention ? (
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
            )}
            <span>{title}</span>
          </div>
          <p className="mt-1 text-sm">
            v{status.latestVersion} is available. {backupText}
            {status.install.gitDirty ? " Local core edits were detected." : ""}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Link
            to="/instance/settings/updates"
            className="inline-flex h-8 items-center justify-center gap-2 rounded-md border border-current/25 bg-background/70 px-3 text-xs font-medium transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Updates
          </Link>
          <button
            type="button"
            disabled={dismissMutation.isPending}
            onClick={() => dismissMutation.mutate(status.latestVersion)}
            className="inline-flex h-8 items-center justify-center gap-2 rounded-md px-3 text-xs font-medium opacity-75 transition-colors hover:bg-background/50 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          >
            <BellOff className="h-3.5 w-3.5" />
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
