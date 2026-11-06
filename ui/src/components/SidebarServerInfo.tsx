import { useQuery } from "@tanstack/react-query";
import { Clock3, FileDiff, GitCommit, type LucideIcon } from "lucide-react";
import { healthApi, type HealthStatus } from "@/api/health";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";
import { t, useTranslation } from "@/i18n";

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return t("nav.sidebarServerInfo.unavailable");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t("nav.sidebarServerInfo.unavailable");
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function isValidTimestamp(value: string | null | undefined): value is string {
  return !!value && !Number.isNaN(new Date(value).getTime());
}

function restartTimestamp(health: HealthStatus | undefined): string | null {
  return health?.devServer?.lastRestartAt ?? health?.serverInfo?.processStartedAt ?? null;
}

function commitLabel(health: HealthStatus | undefined): string {
  const git = health?.serverInfo?.git;
  if (!git?.available) return t("nav.sidebarServerInfo.commitUnavailable");
  return `${git.shortSha} · ${git.subject}`;
}

function localChangesLabel(health: HealthStatus | undefined): string {
  const git = health?.serverInfo?.git;
  if (!git?.available) return t("nav.sidebarServerInfo.unavailable");
  const localChanges = git.localChanges;
  if (!localChanges) return t("nav.sidebarServerInfo.changeStatusUnavailable");
  if (!localChanges.available) return t("nav.sidebarServerInfo.changeStatusUnavailable");
  if (!localChanges.hasLocalChanges) return t("nav.sidebarServerInfo.cleanCheckout");

  const parts = [
    [localChanges.stagedFileCount, t("nav.sidebarServerInfo.staged")],
    [localChanges.unstagedFileCount, t("nav.sidebarServerInfo.unstaged")],
    [localChanges.untrackedFileCount, t("nav.sidebarServerInfo.untracked")],
  ]
    .filter(([count]) => Number(count) > 0)
    .map(([count, label]) => `${count} ${label}`);

  return parts.length > 0
    ? t("nav.sidebarServerInfo.localChangesWithParts", { parts: parts.join(", ") })
    : t("nav.sidebarServerInfo.localChanges");
}

function ServerInfoRow({
  icon: Icon,
  label,
  value,
  dateTime,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  dateTime?: string | null;
}) {
  return (
    <div className="flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left">
      <span className="mt-0.5 rounded-lg border border-border bg-background/70 p-2 text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        {dateTime ? (
          <time dateTime={dateTime} className="block break-words text-xs text-muted-foreground">
            {value}
          </time>
        ) : (
          <span className="block break-words text-xs text-muted-foreground">{value}</span>
        )}
      </span>
    </div>
  );
}

export function SidebarServerInfo() {
  const { t } = useTranslation();
  const experimentalQuery = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const enabled = experimentalQuery.data?.enableServerInfoDebugView === true;
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    enabled,
    // The drawer only mounts while the account popover is open, so it cannot
    // rely on Layout's background health poll (which is itself gated on
    // devServer.enabled). Always refetch on open and poll while open so a server
    // restart is reflected without leaving stale boot-time serverInfo on screen.
    refetchOnMount: "always",
    refetchInterval: (query) => {
      const data = query.state.data as HealthStatus | undefined;
      return data?.devServer?.enabled ? 2000 : false;
    },
  });

  if (!enabled) return null;

  const health = healthQuery.data;
  const isWaitingForHealth = healthQuery.isLoading && !health;
  const healthUnavailable = healthQuery.isError;
  const restartedAt = restartTimestamp(health);
  const restartedAtIsValid = isValidTimestamp(restartedAt);
  const lastRestartedLabel = healthUnavailable
    ? t("nav.sidebarServerInfo.healthUnavailable")
    : isWaitingForHealth
      ? t("common.loading")
      : formatTimestamp(restartedAt);
  const commit = healthUnavailable
    ? t("nav.sidebarServerInfo.healthUnavailable")
    : isWaitingForHealth
      ? t("common.loading")
      : commitLabel(health);
  const localChanges = healthUnavailable
    ? t("nav.sidebarServerInfo.healthUnavailable")
    : isWaitingForHealth
      ? t("common.loading")
      : localChangesLabel(health);

  return (
    <div className="mt-2 border-t border-border pt-2">
      <p className="px-3 pb-1 pt-1 text-(length:--text-micro) font-medium uppercase tracking-wide text-muted-foreground">
        {t("nav.sidebarServerInfo.server")}
      </p>
      <ServerInfoRow
        icon={Clock3}
        label={t("nav.sidebarServerInfo.lastRestarted")}
        value={lastRestartedLabel}
        dateTime={!healthUnavailable && !isWaitingForHealth && restartedAtIsValid ? restartedAt : null}
      />
      <ServerInfoRow icon={GitCommit} label={t("nav.sidebarServerInfo.runningCommit")} value={commit} />
      <ServerInfoRow icon={FileDiff} label={t("nav.sidebarServerInfo.checkoutState")} value={localChanges} />
    </div>
  );
}
