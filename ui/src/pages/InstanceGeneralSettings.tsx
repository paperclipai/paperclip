import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  BackupRetentionPolicy,
  PaperclipCurrencyPreference,
  PaperclipUiLocalePreference,
} from "@paperclipai/shared";
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
import { useLocale } from "../context/LocaleContext";
import {
  formatRetentionDays,
  formatRetentionMonths,
  formatRetentionWeeks,
  getInstanceAdminCopy,
} from "../lib/instance-admin-copy";
import { queryKeys } from "../lib/queryKeys";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "../lib/utils";

const FEEDBACK_TERMS_URL = import.meta.env.VITE_FEEDBACK_TERMS_URL?.trim() || "https://paperclip.ing/tos";
const TIME_ZONE_OPTIONS = ["system", "Asia/Shanghai", "UTC"] as const;

export function InstanceGeneralSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { t, locale, timeZone, currencyCode } = useLocale();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const adminCopy = getInstanceAdminCopy(locale);

  const signOutMutation = useMutation({
    mutationFn: () => authApi.signOut(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : t("common.failedSignOut"));
    },
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: t("settings.general.instanceTitle") },
      { label: t("settings.general.title") },
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
      setActionError(error instanceof Error ? error.message : t("common.failedUpdateGeneralSettings"));
    },
  });

  if (generalQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">{t("common.loadingGeneralSettings")}</div>;
  }

  if (generalQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {generalQuery.error instanceof Error
          ? generalQuery.error.message
          : t("common.failedLoadGeneralSettings")}
      </div>
    );
  }

  const censorUsernameInLogs = generalQuery.data?.censorUsernameInLogs === true;
  const keyboardShortcuts = generalQuery.data?.keyboardShortcuts === true;
  const feedbackDataSharingPreference = generalQuery.data?.feedbackDataSharingPreference ?? "prompt";
  const backupRetention: BackupRetentionPolicy = generalQuery.data?.backupRetention ?? DEFAULT_BACKUP_RETENTION;
  const selectedLocale = generalQuery.data?.locale ?? "system";
  const selectedTimeZone = generalQuery.data?.timeZone ?? "system";
  const selectedCurrency = generalQuery.data?.currencyCode ?? "default";

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t("settings.general.title")}</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {t("settings.general.description")}
        </p>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      <section className="grid gap-4 rounded-xl border border-border bg-card p-5 lg:grid-cols-3">
        <div className="space-y-2">
          <h2 className="text-sm font-semibold">{t("settings.general.languageTitle")}</h2>
          <p className="text-sm text-muted-foreground">{t("settings.general.languageDescription")}</p>
          <Select
            value={selectedLocale}
            onValueChange={(value) =>
              updateGeneralMutation.mutate({ locale: value as PaperclipUiLocalePreference })
            }
            disabled={updateGeneralMutation.isPending}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">{t("settings.general.locale.system")}</SelectItem>
              <SelectItem value="en">{t("settings.general.locale.en")}</SelectItem>
              <SelectItem value="zh-CN">{t("settings.general.locale.zh-CN")}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t("settings.general.languageHelp")}</p>
        </div>

        <div className="space-y-2">
          <h2 className="text-sm font-semibold">{t("settings.general.timeZoneTitle")}</h2>
          <p className="text-sm text-muted-foreground">{t("settings.general.timeZoneDescription")}</p>
          <Select
            value={selectedTimeZone}
            onValueChange={(value) => updateGeneralMutation.mutate({ timeZone: value })}
            disabled={updateGeneralMutation.isPending}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIME_ZONE_OPTIONS.map((value) => (
                <SelectItem key={value} value={value}>
                  {value === "system" ? t("settings.general.timeZone.system") : value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t("settings.general.timeZoneHelp")}</p>
        </div>

        <div className="space-y-2">
          <h2 className="text-sm font-semibold">{t("settings.general.currencyTitle")}</h2>
          <p className="text-sm text-muted-foreground">{t("settings.general.currencyDescription")}</p>
          <Select
            value={selectedCurrency}
            onValueChange={(value) =>
              updateGeneralMutation.mutate({ currencyCode: value as PaperclipCurrencyPreference })
            }
            disabled={updateGeneralMutation.isPending}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">{t("settings.general.currency.default")}</SelectItem>
              <SelectItem value="USD">{t("settings.general.currency.USD")}</SelectItem>
              <SelectItem value="CNY">{t("settings.general.currency.CNY")}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t("settings.general.currencyHelp")}</p>
        </div>

        <div className="rounded-lg border border-border/70 bg-accent/20 px-3 py-2 text-sm text-muted-foreground lg:col-span-3">
          <div className="font-medium text-foreground">{t("settings.general.preview")}</div>
          <div className="mt-1">
            {t("settings.general.previewValue", {
              locale,
              timeZone,
              currency: currencyCode,
            })}
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{t("settings.general.censorTitle")}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t("settings.general.censorDescription")}
            </p>
          </div>
          <ToggleSwitch
            checked={censorUsernameInLogs}
            onCheckedChange={() => updateGeneralMutation.mutate({ censorUsernameInLogs: !censorUsernameInLogs })}
            disabled={updateGeneralMutation.isPending}
            aria-label={adminCopy.general.toggleCensorAria}
          />
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{t("settings.general.keyboardTitle")}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t("settings.general.keyboardDescription")}
            </p>
          </div>
          <ToggleSwitch
            checked={keyboardShortcuts}
            onCheckedChange={() => updateGeneralMutation.mutate({ keyboardShortcuts: !keyboardShortcuts })}
            disabled={updateGeneralMutation.isPending}
            aria-label={adminCopy.general.toggleKeyboardAria}
          />
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-5">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{adminCopy.general.backupRetention}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {adminCopy.general.backupRetentionDescription}
            </p>
          </div>

          <div className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{adminCopy.general.daily}</h3>
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
                      <div className="text-sm font-medium">{formatRetentionDays(days, locale)}</div>
                    </button>
                  );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{adminCopy.general.weekly}</h3>
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
                      <div className="text-sm font-medium">{formatRetentionWeeks(weeks, locale)}</div>
                    </button>
                  );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{adminCopy.general.monthly}</h3>
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
                      <div className="text-sm font-medium">{formatRetentionMonths(months, locale)}</div>
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
            <h2 className="text-sm font-semibold">{t("settings.general.feedbackTitle")}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t("settings.general.feedbackDescription")}
            </p>
            {FEEDBACK_TERMS_URL ? (
              <a
                href={FEEDBACK_TERMS_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
              >
                {t("settings.general.feedbackTerms")}
              </a>
            ) : null}
          </div>
          {feedbackDataSharingPreference === "prompt" ? (
            <div className="rounded-lg border border-border/70 bg-accent/20 px-3 py-2 text-sm text-muted-foreground">
              {t("settings.general.feedbackPromptNotice")}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {[
              {
                value: "allowed",
                label: t("settings.general.feedbackAllowed"),
                description: t("settings.general.feedbackAllowedDescription"),
              },
              {
                value: "not_allowed",
                label: t("settings.general.feedbackNotAllowed"),
                description: t("settings.general.feedbackNotAllowedDescription"),
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
            {t("settings.general.feedbackResetNote")}
          </p>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{t("settings.general.signOutTitle")}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t("settings.general.signOutDescription")}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={signOutMutation.isPending}
            onClick={() => signOutMutation.mutate()}
          >
            <LogOut className="size-4" />
            {signOutMutation.isPending ? t("settings.general.signingOut") : t("settings.general.signOut")}
          </Button>
        </div>
      </section>
    </div>
  );
}
