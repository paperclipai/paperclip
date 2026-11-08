import { Trans, useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PatchInstanceGeneralSettings, BackupRetentionPolicy } from "@paperclipai/shared";
import {
  DAILY_RETENTION_PRESETS,
  WEEKLY_RETENTION_PRESETS,
  MONTHLY_RETENTION_PRESETS,
  DEFAULT_BACKUP_RETENTION,
} from "@paperclipai/shared";
import { LogOut, SlidersHorizontal } from "lucide-react";
import { describeError } from "@/api/errors";
import { healthApi } from "@/api/health";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { Badge } from "@/components/ui/badge";
import { Button } from "../components/ui/button";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { cn } from "../lib/utils";
import { useSignOut } from "@/hooks/useSignOut";

const FEEDBACK_TERMS_URL = import.meta.env.VITE_FEEDBACK_TERMS_URL?.trim() || "https://paperclip.ing/tos";

export function InstanceGeneralSettings({ embedded = false }: { embedded?: boolean }) {
  const { t, i18n } = useTranslation("settings");
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<{ cause: unknown } | null>(null);

  const signOutMutation = useSignOut();

  useEffect(() => {
    if (embedded) return;
    setBreadcrumbs([
      { label: t("instanceGeneralSettings.settings"), href: "/company/settings" },
      { label: t("instanceGeneralSettings.general") },
    ]);
  }, [t, embedded, setBreadcrumbs]);

  const generalQuery = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
  });
  const generalView = useQueryView(generalQuery);
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
  });

  const updateGeneralMutation = useMutation({
    mutationFn: instanceSettingsApi.updateGeneral,
    onMutate: () => {
      setActionError(null);
      signOutMutation.reset();
    },
    onSuccess: async () => {
      setActionError(null);
      signOutMutation.reset();
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.generalSettings });
    },
    onError: (error) => {
      setActionError({ cause: error });
    },
  });

  if (generalQuery.isLoading || generalView.kind === "reconnecting" || healthQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">{t("instanceGeneralSettings.loading_general_settings")}</div>;
  }

  if (generalView.kind === "error") {
    return (
      <QueryErrorState
        size={embedded ? "panel" : "page"}
        error={generalQuery.error}
        action={t("instanceGeneralSettings.load_general_settings")}
        onRetry={generalView.retry}
        retrying={generalView.isFetching}
      />
    );
  }

  const censorUsernameInLogs = generalQuery.data?.censorUsernameInLogs === true;
  const feedbackDataSharingPreference = generalQuery.data?.feedbackDataSharingPreference ?? "prompt";
  const backupRetention: BackupRetentionPolicy = generalQuery.data?.backupRetention ?? DEFAULT_BACKUP_RETENTION;
  const hiddenSettings = new Set(healthQuery.data?.hiddenSettings ?? []);
  const showDeploymentStatus = !hiddenSettings.has("instance.general.deploymentStatus");
  const showCensorUsernameInLogs = !hiddenSettings.has("instance.general.censorUsernameInLogs");
  const showBackupRetention = !hiddenSettings.has("instance.general.backupRetention");
  const showFeedbackDataSharing = !hiddenSettings.has("instance.general.feedbackDataSharingPreference");
  const showSignOut = !hiddenSettings.has("instance.general.signOut");
  const visibleTopics = [
    ...(showCensorUsernameInLogs ? [t("instanceGeneralSettings.log_display")] : []),
    ...(showBackupRetention ? [t("instanceGeneralSettings.backup_retention")] : []),
    ...(showFeedbackDataSharing ? [t("instanceGeneralSettings.data_sharing")] : []),
  ];
  const topicSummary = new Intl.ListFormat(i18n.language, { style: "long", type: "conjunction" }).format(visibleTopics);
  const visibleActionError = signOutMutation.error
    ? describeError(signOutMutation.error).body
    : actionError ? describeError(actionError.cause).body : null;

  return (
    <div className={embedded ? "space-y-8" : "max-w-4xl space-y-8"}>
      {!embedded ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-lg font-semibold">{t("instanceGeneralSettings.general")}</h1>
          </div>
          <p className="text-sm text-muted-foreground">{visibleTopics.length > 0 ? t("instanceGeneralSettings.overview", { topics: topicSummary }) : t("instanceGeneralSettings.overviewEmpty")}
          </p>
        </div>
      ) : null}

      {visibleActionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {visibleActionError}
        </div>
      )}

      {showDeploymentStatus && (
      <section>
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">{t("instanceGeneralSettings.deployment_and_auth")}</h2>
            {healthQuery.data?.deploymentMode ? <Badge variant="outline">{healthQuery.data.deploymentMode === "local_trusted" ? t("deep-ui:mode_local") : healthQuery.data.deploymentExposure === "public" ? t("deep-ui:mode_public") : t("deep-ui:mode_private")}</Badge> : null}
          </div>
          <div className="text-sm text-muted-foreground">
            {healthQuery.data?.deploymentMode === "local_trusted"
              ? t("instanceGeneralSettings.local_trusted_mode_is_optimized_for_a_local_operator")
              : healthQuery.data?.deploymentExposure === "public"
                ? t("instanceGeneralSettings.authenticated_public_mode_requires_sign_in_for_board_access")
                : t("instanceGeneralSettings.authenticated_private_mode_requires_sign_in_and_is_intended")}
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <StatusBox
              label={t("instanceGeneralSettings.auth_readiness")}
              value={healthQuery.data?.authReady ? t("instanceGeneralSettings.ready") : t("instanceGeneralSettings.not_ready")}
            />
            <StatusBox
              label={t("instanceGeneralSettings.bootstrap_status")}
              value={healthQuery.data?.bootstrapStatus === "bootstrap_pending" ? t("instanceGeneralSettings.setup_required") : t("instanceGeneralSettings.ready")}
            />
            <StatusBox
              label={t("instanceGeneralSettings.bootstrap_invite")}
              value={healthQuery.data?.bootstrapInviteActive ? t("instanceGeneralSettings.active") : t("instanceGeneralSettings.none")}
            />
          </div>
        </div>
      </section>
      )}

      {showCensorUsernameInLogs && (
      <section>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{t("instanceGeneralSettings.censor_username_in_logs")}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">{t("instanceGeneralSettings.hide_the_username_segment_in_home_directory_paths_and")}</p>
          </div>
          <ToggleSwitch
            checked={censorUsernameInLogs}
            onCheckedChange={() => updateGeneralMutation.mutate({ censorUsernameInLogs: !censorUsernameInLogs })}
            disabled={updateGeneralMutation.isPending || signOutMutation.isPending}
            aria-label={t("instanceGeneralSettings.toggle_username_log_censoring")}
          />
        </div>
      </section>
      )}

      {showBackupRetention && (
      <section>
        <div className="space-y-5">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{t("instanceGeneralSettings.backup_retention_771")}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">{t("instanceGeneralSettings.configure_how_long_automatic_database_backups_are_retained_backups")}</p>
          </div>

          <div className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t("instanceGeneralSettings.daily")}</h3>
            <div className="flex flex-wrap gap-2">
              {DAILY_RETENTION_PRESETS.map((days) => {
                const active = backupRetention.dailyDays === days;
                return (
                  <button
                    key={days}
                    type="button"
                    disabled={updateGeneralMutation.isPending || signOutMutation.isPending}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                      active
                        ? "border-foreground bg-accent text-foreground"
                        : "border-border bg-background hover:bg-accent/50",
                    )}
                    onClick={() =>
                      updateGeneralMutation.mutate({
                        backupRetention: { ...backupRetention, dailyDays: days },
                      })
                    }
                  >
                    <div className="text-sm font-medium">{t("instanceGeneralSettings.days", { count: days })}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t("instanceGeneralSettings.weekly")}</h3>
            <div className="flex flex-wrap gap-2">
              {WEEKLY_RETENTION_PRESETS.map((weeks) => {
                const active = backupRetention.weeklyWeeks === weeks;
                const label = t("instanceGeneralSettings.weeks", { count: weeks });
                return (
                  <button
                    key={weeks}
                    type="button"
                    disabled={updateGeneralMutation.isPending || signOutMutation.isPending}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                      active
                        ? "border-foreground bg-accent text-foreground"
                        : "border-border bg-background hover:bg-accent/50",
                    )}
                    onClick={() =>
                      updateGeneralMutation.mutate({
                        backupRetention: { ...backupRetention, weeklyWeeks: weeks },
                      })
                    }
                  >
                    <div className="text-sm font-medium">{label}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t("instanceGeneralSettings.monthly")}</h3>
            <div className="flex flex-wrap gap-2">
              {MONTHLY_RETENTION_PRESETS.map((months) => {
                const active = backupRetention.monthlyMonths === months;
                const label = t("instanceGeneralSettings.months", { count: months });
                return (
                  <button
                    key={months}
                    type="button"
                    disabled={updateGeneralMutation.isPending || signOutMutation.isPending}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                      active
                        ? "border-foreground bg-accent text-foreground"
                        : "border-border bg-background hover:bg-accent/50",
                    )}
                    onClick={() =>
                      updateGeneralMutation.mutate({
                        backupRetention: { ...backupRetention, monthlyMonths: months },
                      })
                    }
                  >
                    <div className="text-sm font-medium">{label}</div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>
      )}

      {showFeedbackDataSharing && (
      <section>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{t("instanceGeneralSettings.ai_feedback_sharing")}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">{t("instanceGeneralSettings.control_whether_thumbs_up_and_thumbs_down_votes_can")}</p>
            {FEEDBACK_TERMS_URL ? (
              <a
                href={FEEDBACK_TERMS_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
              >{t("instanceGeneralSettings.read_our_terms_of_service")}</a>
            ) : null}
          </div>
          {feedbackDataSharingPreference === "prompt" ? (
            <div className="rounded-lg bg-accent/20 px-3 py-2 text-sm text-muted-foreground">{t("instanceGeneralSettings.no_default_is_saved_yet_the_next_thumbs_up")}</div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {[
              {
                value: "allowed",
                label: t("instanceGeneralSettings.always_allow"),
                description: t("instanceGeneralSettings.share_voted_ai_outputs_automatically"),
              },
              {
                value: "not_allowed",
                label: t("instanceGeneralSettings.don_t_allow"),
                description: t("instanceGeneralSettings.keep_voted_ai_outputs_local_only"),
              },
            ].map((option) => {
              const active = feedbackDataSharingPreference === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  disabled={updateGeneralMutation.isPending || signOutMutation.isPending}
                  className={cn(
                    "rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                    active
                      ? "border-foreground bg-accent text-foreground"
                      : "border-border bg-background hover:bg-accent/50",
                  )}
                  onClick={() =>
                    updateGeneralMutation.mutate({
                      feedbackDataSharingPreference: option.value as
                        | "allowed"
                        | "not_allowed",
                    })
                  }
                >
                  <div className="text-sm font-medium">{option.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {option.description}
                  </div>
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground"><Trans t={t} i18nKey="instanceGeneralSettings.retestPrompt" components={{ code: <code /> }} />
          </p>
        </div>
      </section>

      )}

      {showSignOut && (
      <section>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{t("instanceGeneralSettings.sign_out")}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">{t("instanceGeneralSettings.sign_out_of_this_paperclip_instance_you_will_be")}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={signOutMutation.isPending || updateGeneralMutation.isPending}
            onClick={() => {
              setActionError(null);
              signOutMutation.mutate();
            }}
          >
            <LogOut className="size-4" />
            {signOutMutation.isPending ? t("instanceGeneralSettings.signing_out") : t("instanceGeneralSettings.sign_out")}
          </Button>
        </div>
      </section>
      )}
    </div>
  );
}

function StatusBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm font-medium">{value}</div>
    </div>
  );
}
