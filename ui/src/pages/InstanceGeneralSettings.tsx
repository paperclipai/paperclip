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
import { authApi } from "@/api/auth";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { Button } from "../components/ui/button";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useI18n, type SupportedLocale } from "@/i18n/runtime";
import { cn } from "../lib/utils";

const FEEDBACK_TERMS_URL = import.meta.env.VITE_FEEDBACK_TERMS_URL?.trim() || "https://paperclip.ing/tos";

export function InstanceGeneralSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { locale, setLocale, t } = useI18n();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  const signOutMutation = useMutation({
    mutationFn: () => authApi.signOut(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : t("instanceGeneral.error.signOut", "Failed to sign out."));
    },
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: t("instanceGeneral.breadcrumb.settings", "Instance Settings") },
      { label: t("instanceGeneral.breadcrumb.general", "General") },
    ]);
  }, [setBreadcrumbs, t]);

  const generalQuery = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
  });

  const updateGeneralMutation = useMutation({
    mutationFn: instanceSettingsApi.updateGeneral,
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.generalSettings });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : t("instanceGeneral.error.update", "Failed to update general settings."));
    },
  });

  if (generalQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">{t("instanceGeneral.loading", "Loading general settings...")}</div>;
  }

  if (generalQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {generalQuery.error instanceof Error
          ? generalQuery.error.message
          : t("instanceGeneral.error.load", "Failed to load general settings.")}
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
          <h1 className="text-lg font-semibold">{t("instanceGeneral.title", "General")}</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {t(
            "instanceGeneral.subtitle",
            "Configure instance-wide defaults that affect how operator-visible logs are displayed.",
          )}
        </p>
      </div>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{t("instanceGeneral.locale.title", "Language")}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t(
                "instanceGeneral.locale.description",
                "Choose the UI language for this browser. Missing translations fall back to English.",
              )}
            </p>
          </div>
          <label className="flex flex-col gap-2 text-sm text-foreground">
            <span className="sr-only">{t("instanceGeneral.locale.title", "Language")}</span>
            <select
              value={locale}
              onChange={(event) => setLocale(event.target.value as SupportedLocale)}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm"
              aria-label={t("instanceGeneral.locale.title", "Language")}
            >
              <option value="en">{t("instanceGeneral.locale.option.en", "English")}</option>
              <option value="zh-CN">{t("instanceGeneral.locale.option.zhCN", "简体中文")}</option>
            </select>
          </label>
        </div>
      </section>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{t("instanceGeneral.censor.title", "Censor username in logs")}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t(
                "instanceGeneral.censor.description",
                "Hide the username segment in home-directory paths and similar operator-visible log output. Standalone username mentions outside of paths are not yet masked in the live transcript view. This is off by default.",
              )}
            </p>
          </div>
          <ToggleSwitch
            checked={censorUsernameInLogs}
            onCheckedChange={() => updateGeneralMutation.mutate({ censorUsernameInLogs: !censorUsernameInLogs })}
            disabled={updateGeneralMutation.isPending}
            aria-label={t("instanceGeneral.censor.aria", "Toggle username log censoring")}
          />
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{t("instanceGeneral.shortcuts.title", "Keyboard shortcuts")}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t(
                "instanceGeneral.shortcuts.description",
                "Enable app keyboard shortcuts, including inbox navigation and global shortcuts like creating issues or toggling panels. This is off by default.",
              )}
            </p>
          </div>
          <ToggleSwitch
            checked={keyboardShortcuts}
            onCheckedChange={() => updateGeneralMutation.mutate({ keyboardShortcuts: !keyboardShortcuts })}
            disabled={updateGeneralMutation.isPending}
            aria-label={t("instanceGeneral.shortcuts.aria", "Toggle keyboard shortcuts")}
          />
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-5">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{t("instanceGeneral.backup.title", "Backup retention")}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t(
                "instanceGeneral.backup.description",
                "Configure how long to keep automatic database backups at each tier. Daily backups are kept in full, then thinned to one per week and one per month. Backups are compressed with gzip.",
              )}
            </p>
          </div>

          <div className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {t("instanceGeneral.backup.daily", "Daily")}
            </h3>
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
                    <div className="text-sm font-medium">
                      {locale === "zh-CN"
                        ? `${days}${t("instanceGeneral.backup.daysSuffix", "天")}`
                        : `${days} ${t("instanceGeneral.backup.daysSuffix", "days")}`}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {t("instanceGeneral.backup.weekly", "Weekly")}
            </h3>
            <div className="flex flex-wrap gap-2">
              {WEEKLY_RETENTION_PRESETS.map((weeks) => {
                const active = backupRetention.weeklyWeeks === weeks;
                const label = locale === "zh-CN"
                  ? `${weeks}${t("instanceGeneral.backup.weeks", "周")}`
                  : weeks === 1
                    ? `1 ${t("instanceGeneral.backup.week", "week")}`
                    : `${weeks} ${t("instanceGeneral.backup.weeks", "weeks")}`;
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
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {t("instanceGeneral.backup.monthly", "Monthly")}
            </h3>
            <div className="flex flex-wrap gap-2">
              {MONTHLY_RETENTION_PRESETS.map((months) => {
                const active = backupRetention.monthlyMonths === months;
                const label = locale === "zh-CN"
                  ? `${months}${t("instanceGeneral.backup.months", "个月")}`
                  : months === 1
                    ? `1 ${t("instanceGeneral.backup.month", "month")}`
                    : `${months} ${t("instanceGeneral.backup.months", "months")}`;
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
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{t("instanceGeneral.feedback.title", "AI feedback sharing")}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t(
                "instanceGeneral.feedback.description",
                "Control whether thumbs up and thumbs down votes can send the voted AI output to Paperclip Labs. Votes are always saved locally.",
              )}
            </p>
            {FEEDBACK_TERMS_URL ? (
              <a
                href={FEEDBACK_TERMS_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
              >
                {t("instanceGeneral.feedback.terms", "Read our terms of service")}
              </a>
            ) : null}
          </div>
          {feedbackDataSharingPreference === "prompt" ? (
            <div className="rounded-lg border border-border/70 bg-accent/20 px-3 py-2 text-sm text-muted-foreground">
              {t(
                "instanceGeneral.feedback.prompt",
                "No default is saved yet. The next thumbs up or thumbs down choice will ask once and then save the answer here.",
              )}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {[
              {
                value: "allowed",
                label: t("instanceGeneral.feedback.option.allowed.label", "Always allow"),
                description: t(
                  "instanceGeneral.feedback.option.allowed.description",
                  "Share voted AI outputs automatically.",
                ),
              },
              {
                value: "not_allowed",
                label: t("instanceGeneral.feedback.option.notAllowed.label", "Do not allow"),
                description: t(
                  "instanceGeneral.feedback.option.notAllowed.description",
                  "Keep voted AI outputs local only.",
                ),
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
            {locale === "zh-CN" ? (
              <>
                如果要在本地开发里重新测试首次提示，请从此实例的 <code>instance_settings.general</code> JSON 行中移除{" "}
                <code>feedbackDataSharingPreference</code> 键，或把它设回 <code>"prompt"</code>。未设置和{" "}
                <code>"prompt"</code> 都表示尚未选择默认值。
              </>
            ) : (
              <>
                To retest the first-use prompt in local dev, remove the <code>feedbackDataSharingPreference</code> key from the{" "}
                <code>instance_settings.general</code> JSON row for this instance, or set it back to <code>"prompt"</code>. Unset and{" "}
                <code>"prompt"</code> both mean no default has been chosen yet.
              </>
            )}
          </p>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{t("instanceGeneral.signOut.title", "Sign out")}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t(
                "instanceGeneral.signOut.description",
                "Sign out of this Paperclip instance. You will be redirected to the login page.",
              )}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={signOutMutation.isPending}
            onClick={() => signOutMutation.mutate()}
          >
            <LogOut className="size-4" />
            {signOutMutation.isPending
              ? t("common.signingOut", "Signing out...")
              : t("common.signOut", "Sign out")}
          </Button>
        </div>
      </section>
    </div>
  );
}
