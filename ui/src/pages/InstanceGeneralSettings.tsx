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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : t("instanceGeneralSettings.signOutFailed"));
    },
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: t("instanceGeneralSettings.breadcrumbRoot") },
      { label: t("instanceGeneralSettings.breadcrumbGeneral") },
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
      setActionError(error instanceof Error ? error.message : t("instanceGeneralSettings.errorUpdate"));
    },
  });

  if (generalQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">{t("instanceGeneralSettings.loading")}</div>;
  }

  if (generalQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {generalQuery.error instanceof Error
          ? generalQuery.error.message
          : t("instanceGeneralSettings.errorLoad")}
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
          <h1 className="text-lg font-semibold">{t("instanceGeneralSettings.heading")}</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {t("instanceGeneralSettings.description")}
        </p>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">{t("instanceGeneralSettings.deployment.heading")}</h2>
            <ModeBadge
              deploymentMode={healthQuery.data?.deploymentMode}
              deploymentExposure={healthQuery.data?.deploymentExposure}
            />
          </div>
          <div className="text-sm text-muted-foreground">
            {healthQuery.data?.deploymentMode === "local_trusted"
              ? t("instanceGeneralSettings.deployment.localTrusted")
              : healthQuery.data?.deploymentExposure === "public"
                ? t("instanceGeneralSettings.deployment.publicAuth")
                : t("instanceGeneralSettings.deployment.privateAuth")}
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <StatusBox
              label={t("instanceGeneralSettings.deployment.authReady")}
              value={healthQuery.data?.authReady ? t("instanceGeneralSettings.deployment.ready") : t("instanceGeneralSettings.deployment.notReady")}
            />
            <StatusBox
              label={t("instanceGeneralSettings.deployment.bootstrapStatus")}
              value={healthQuery.data?.bootstrapStatus === "bootstrap_pending" ? t("instanceGeneralSettings.deployment.setupRequired") : t("instanceGeneralSettings.deployment.ready")}
            />
            <StatusBox
              label={t("instanceGeneralSettings.deployment.bootstrapInvite")}
              value={healthQuery.data?.bootstrapInviteActive ? t("instanceGeneralSettings.deployment.active") : t("instanceGeneralSettings.deployment.none")}
            />
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{t("instanceGeneralSettings.censorHeading")}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t("instanceGeneralSettings.censorDescription")}
            </p>
          </div>
          <ToggleSwitch
            checked={censorUsernameInLogs}
            onCheckedChange={() => updateGeneralMutation.mutate({ censorUsernameInLogs: !censorUsernameInLogs })}
            disabled={updateGeneralMutation.isPending}
            aria-label={t("instanceGeneralSettings.censorToggleAria")}
          />
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{t("instanceGeneralSettings.shortcuts.heading")}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t("instanceGeneralSettings.shortcuts.description")}
            </p>
          </div>
          <ToggleSwitch
            checked={keyboardShortcuts}
            onCheckedChange={() => updateGeneralMutation.mutate({ keyboardShortcuts: !keyboardShortcuts })}
            disabled={updateGeneralMutation.isPending}
            aria-label={t("instanceGeneralSettings.shortcuts.toggleAria")}
          />
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-5">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{t("instanceGeneralSettings.backup.heading")}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t("instanceGeneralSettings.backup.description")}
            </p>
          </div>

          <div className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t("instanceGeneralSettings.backup.daily")}</h3>
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
                    <div className="text-sm font-medium">{t("instanceGeneralSettings.backup.days", { count: days })}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t("instanceGeneralSettings.backup.weekly")}</h3>
            <div className="flex flex-wrap gap-2">
              {WEEKLY_RETENTION_PRESETS.map((weeks) => {
                const active = backupRetention.weeklyWeeks === weeks;
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
                    <div className="text-sm font-medium">{t("instanceGeneralSettings.backup.week", { count: weeks })}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t("instanceGeneralSettings.backup.monthly")}</h3>
            <div className="flex flex-wrap gap-2">
              {MONTHLY_RETENTION_PRESETS.map((months) => {
                const active = backupRetention.monthlyMonths === months;
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
                    <div className="text-sm font-medium">{t("instanceGeneralSettings.backup.month", { count: months })}</div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{t("instanceGeneralSettings.feedback.heading")}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t("instanceGeneralSettings.feedback.description")}
            </p>
            {FEEDBACK_TERMS_URL ? (
              <a
                href={FEEDBACK_TERMS_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
              >
                {t("instanceGeneralSettings.feedback.readTerms")}
              </a>
            ) : null}
          </div>
          {feedbackDataSharingPreference === "prompt" ? (
            <div className="rounded-lg border border-border/70 bg-accent/20 px-3 py-2 text-sm text-muted-foreground">
              {t("instanceGeneralSettings.feedback.prompt")}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {[
              {
                value: "allowed",
                label: t("instanceGeneralSettings.feedback.allowedLabel"),
                description: t("instanceGeneralSettings.feedback.allowedDescription"),
              },
              {
                value: "not_allowed",
                label: t("instanceGeneralSettings.feedback.notAllowedLabel"),
                description: t("instanceGeneralSettings.feedback.notAllowedDescription"),
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
            {t("instanceGeneralSettings.feedback.devHint")}
          </p>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{t("instanceGeneralSettings.signOut.heading")}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t("instanceGeneralSettings.signOut.description")}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={signOutMutation.isPending}
            onClick={() => signOutMutation.mutate()}
          >
            <LogOut className="size-4" />
            {signOutMutation.isPending ? t("instanceGeneralSettings.signOut.pending") : t("instanceGeneralSettings.signOut.action")}
          </Button>
        </div>
      </section>
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
