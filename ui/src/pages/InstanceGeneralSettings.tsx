import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PatchInstanceGeneralSettings, BackupRetentionPolicy } from "@paperclipai/shared";
import {
  DAILY_RETENTION_PRESETS,
  WEEKLY_RETENTION_PRESETS,
  MONTHLY_RETENTION_PRESETS,
  DEFAULT_BACKUP_RETENTION,
} from "@paperclipai/shared";
import { LogOut, SlidersHorizontal } from "lucide-react";
import { authApi } from "@/api/auth";
import { healthApi } from "@/api/health";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { ModeBadge } from "@/components/access/ModeBadge";
import { Button } from "../components/ui/button";
import { Card } from "@/components/ui/card";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { cn } from "../lib/utils";

const FEEDBACK_TERMS_URL = import.meta.env.VITE_FEEDBACK_TERMS_URL?.trim() || "https://paperclip.ing/tos";

export function InstanceGeneralSettings() {
  const { t } = useTranslation();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  const signOutMutation = useMutation({
    mutationFn: () => authApi.signOut(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.health });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : t("settings.generalPage.signOutFailed"));
    },
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: t("navigation.settings"), href: "/company/settings" },
      { label: t("settings.instanceSection") },
      { label: t("settings.general") },
    ]);
  }, [setBreadcrumbs, t]);

  const generalQuery = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
  });
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });

  const updateGeneralMutation = useMutation({
    mutationFn: instanceSettingsApi.updateGeneral,
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.generalSettings });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : t("settings.generalPage.updateFailed"));
    },
  });

  if (generalQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">{t("settings.generalPage.loading")}</div>;
  }

  if (generalQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {generalQuery.error instanceof Error
          ? generalQuery.error.message
          : t("settings.generalPage.loadFailed")}
      </div>
    );
  }

  const censorUsernameInLogs = generalQuery.data?.censorUsernameInLogs === true;
  const keyboardShortcuts = generalQuery.data?.keyboardShortcuts === true;
  const feedbackDataSharingPreference = generalQuery.data?.feedbackDataSharingPreference ?? "prompt";
  const backupRetention: BackupRetentionPolicy = generalQuery.data?.backupRetention ?? DEFAULT_BACKUP_RETENTION;

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t("settings.general")}</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {t("settings.generalPage.description")}
        </p>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      <Card className="block p-5">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">{t("settings.generalPage.deploymentAndAuth")}</h2>
            <ModeBadge
              deploymentMode={healthQuery.data?.deploymentMode}
              deploymentExposure={healthQuery.data?.deploymentExposure}
            />
          </div>
          <div className="text-sm text-muted-foreground">
            {healthQuery.data?.deploymentMode === "local_trusted"
              ? t("settings.generalPage.localTrustedDescription")
              : healthQuery.data?.deploymentExposure === "public"
                ? t("settings.generalPage.publicAuthDescription")
                : t("settings.generalPage.privateAuthDescription")}
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <StatusBox
              label={t("settings.generalPage.authReadiness")}
              value={healthQuery.data?.authReady ? t("settings.generalPage.ready") : t("settings.generalPage.notReady")}
            />
            <StatusBox
              label={t("settings.generalPage.bootstrapStatus")}
              value={healthQuery.data?.bootstrapStatus === "bootstrap_pending" ? t("settings.generalPage.setupRequired") : t("settings.generalPage.ready")}
            />
            <StatusBox
              label={t("settings.generalPage.bootstrapInvite")}
              value={healthQuery.data?.bootstrapInviteActive ? t("common.active") : t("common.none")}
            />
          </div>
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{t("settings.generalPage.censorUsername")}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t("settings.generalPage.censorUsernameDescription")}
            </p>
          </div>
          <ToggleSwitch
            checked={censorUsernameInLogs}
            onCheckedChange={() => updateGeneralMutation.mutate({ censorUsernameInLogs: !censorUsernameInLogs })}
            disabled={updateGeneralMutation.isPending}
            aria-label={t("settings.generalPage.toggleCensorUsername")}
          />
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{t("settings.generalPage.keyboardShortcuts")}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t("settings.generalPage.keyboardShortcutsDescription")}
            </p>
          </div>
          <ToggleSwitch
            checked={keyboardShortcuts}
            onCheckedChange={() => updateGeneralMutation.mutate({ keyboardShortcuts: !keyboardShortcuts })}
            disabled={updateGeneralMutation.isPending}
            aria-label={t("settings.generalPage.toggleKeyboardShortcuts")}
          />
        </div>
      </Card>

      <Card className="block p-5">
        <div className="space-y-5">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{t("settings.generalPage.backupRetention")}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t("settings.generalPage.backupRetentionDescription")}
            </p>
          </div>

          <div className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t("settings.generalPage.daily")}</h3>
            <div className="flex flex-wrap gap-2">
              {DAILY_RETENTION_PRESETS.map((days) => {
                const active = backupRetention.dailyDays === days;
                return (
                  <button
                    key={days}
                    type="button"
                    disabled={updateGeneralMutation.isPending}
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
                    <div className="text-sm font-medium">{t("settings.generalPage.days", { count: days })}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t("settings.generalPage.weekly")}</h3>
            <div className="flex flex-wrap gap-2">
              {WEEKLY_RETENTION_PRESETS.map((weeks) => {
                const active = backupRetention.weeklyWeeks === weeks;
                const label = t("settings.generalPage.weeks", { count: weeks });
                return (
                  <button
                    key={weeks}
                    type="button"
                    disabled={updateGeneralMutation.isPending}
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
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t("settings.generalPage.monthly")}</h3>
            <div className="flex flex-wrap gap-2">
              {MONTHLY_RETENTION_PRESETS.map((months) => {
                const active = backupRetention.monthlyMonths === months;
                const label = t("settings.generalPage.months", { count: months });
                return (
                  <button
                    key={months}
                    type="button"
                    disabled={updateGeneralMutation.isPending}
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
      </Card>

      <Card className="block p-5">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{t("settings.generalPage.aiFeedbackSharing")}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t("settings.generalPage.aiFeedbackSharingDescription")}
            </p>
            {FEEDBACK_TERMS_URL ? (
              <a
                href={FEEDBACK_TERMS_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
              >
                {t("settings.generalPage.readTerms")}
              </a>
            ) : null}
          </div>
          {feedbackDataSharingPreference === "prompt" ? (
            <div className="rounded-lg border border-border/70 bg-accent/20 px-3 py-2 text-sm text-muted-foreground">
              {t("settings.generalPage.noFeedbackDefault")}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {[
              {
                value: "allowed",
                label: t("settings.generalPage.alwaysAllow"),
                description: t("settings.generalPage.alwaysAllowDescription"),
              },
              {
                value: "not_allowed",
                label: t("settings.generalPage.dontAllow"),
                description: t("settings.generalPage.dontAllowDescription"),
              },
            ].map((option) => {
              const active = feedbackDataSharingPreference === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  disabled={updateGeneralMutation.isPending}
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
          <p className="text-xs text-muted-foreground">
            {t("settings.generalPage.feedbackDevHint")}
          </p>
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{t("account.signOut")}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t("settings.generalPage.signOutDescription")}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={signOutMutation.isPending}
            onClick={() => signOutMutation.mutate()}
          >
            <LogOut className="size-4" />
            {signOutMutation.isPending ? t("account.signingOut") : t("account.signOut")}
          </Button>
        </div>
      </Card>
    </div>
  );
}

function StatusBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-background px-3 py-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-2 text-sm font-medium">{value}</div>
    </div>
  );
}
