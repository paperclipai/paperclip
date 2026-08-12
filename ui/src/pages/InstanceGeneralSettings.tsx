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
import { healthApi } from "@/api/health";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { ModeBadge } from "@/components/access/ModeBadge";
import { Button } from "../components/ui/button";
import { Card } from "@/components/ui/card";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { cn } from "../lib/utils";
import { useSignOut } from "@/hooks/useSignOut";
import { useTranslation } from "@/i18n";
import { translateUiLiteral } from "@/i18n/LegacyLiteralLocalizer";

const FEEDBACK_TERMS_URL = import.meta.env.VITE_FEEDBACK_TERMS_URL?.trim() || "https://paperclip.ing/tos";

export function InstanceGeneralSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  const signOutMutation = useSignOut();

  useEffect(() => {
    setBreadcrumbs([
      { label: t("nav.settings"), href: "/company/settings" },
      { label: t("pages.instanceGeneralSettings.instanceSettings", { defaultValue: "Instance settings" }) },
      { label: t("pages.instanceGeneralSettings.general", { defaultValue: "General" }) },
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
      setActionError(error instanceof Error ? error.message : t("pages.instanceGeneralSettings.failedUpdateGeneralSettings", { defaultValue: "Failed to update general settings." }));
    },
  });

  if (generalQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">{t("pages.instanceGeneralSettings.loadingGeneralSettings", { defaultValue: "Loading general settings..." })}</div>;
  }

  if (generalQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {generalQuery.error instanceof Error
          ? generalQuery.error.message
          : t("pages.instanceGeneralSettings.failedLoadGeneralSettings", { defaultValue: "Failed to load general settings." })}
      </div>
    );
  }

  const censorUsernameInLogs = generalQuery.data?.censorUsernameInLogs === true;
  const keyboardShortcuts = generalQuery.data?.keyboardShortcuts === true;
  const feedbackDataSharingPreference = generalQuery.data?.feedbackDataSharingPreference ?? "prompt";
  const backupRetention: BackupRetentionPolicy = generalQuery.data?.backupRetention ?? DEFAULT_BACKUP_RETENTION;
  const visibleActionError = signOutMutation.error instanceof Error
    ? signOutMutation.error.message
    : signOutMutation.error
      ? t("pages.instanceGeneralSettings.failedSignOut", { defaultValue: "Failed to sign out." })
      : actionError;

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t("pages.instanceGeneralSettings.general", { defaultValue: "General" })}</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {t("pages.instanceGeneralSettings.description", { defaultValue: "Configure instance-wide preferences including log display, keyboard shortcuts, backup retention, and data sharing." })}
        </p>
      </div>

      {visibleActionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {visibleActionError}
        </div>
      )}

      <Card className="block p-5">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">{t("pages.instanceGeneralSettings.deploymentAndAuth", { defaultValue: "Deployment and auth" })}</h2>
            <ModeBadge
              deploymentMode={healthQuery.data?.deploymentMode}
              deploymentExposure={healthQuery.data?.deploymentExposure}
            />
          </div>
          <div className="text-sm text-muted-foreground">
            {healthQuery.data?.deploymentMode === "local_trusted"
              ? t("pages.instanceGeneralSettings.localTrustedModeDescription", { defaultValue: "Local trusted mode is optimized for a local operator. Browser requests run as local board context and no sign-in is required." })
              : healthQuery.data?.deploymentExposure === "public"
                ? t("pages.instanceGeneralSettings.publicModeDescription", { defaultValue: "Authenticated public mode requires sign-in for board access and is intended for public URLs." })
                : t("pages.instanceGeneralSettings.privateModeDescription", { defaultValue: "Authenticated private mode requires sign-in and is intended for LAN, VPN, or other private-network deployments." })}
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <StatusBox
              label={t("pages.instanceGeneralSettings.authReadiness", { defaultValue: "Auth readiness" })}
              value={healthQuery.data?.authReady ? t("pages.instanceGeneralSettings.ready", { defaultValue: "Ready" }) : t("pages.instanceGeneralSettings.notReady", { defaultValue: "Not ready" })}
            />
            <StatusBox
              label={t("pages.instanceGeneralSettings.bootstrapStatus", { defaultValue: "Bootstrap status" })}
              value={healthQuery.data?.bootstrapStatus === "bootstrap_pending" ? t("pages.instanceGeneralSettings.setupRequired", { defaultValue: "Setup required" }) : t("pages.instanceGeneralSettings.ready", { defaultValue: "Ready" })}
            />
            <StatusBox
              label={t("pages.instanceGeneralSettings.bootstrapInvite", { defaultValue: "Bootstrap invite" })}
              value={healthQuery.data?.bootstrapInviteActive ? t("pages.instanceGeneralSettings.active", { defaultValue: "Active" }) : t("pages.instanceGeneralSettings.none", { defaultValue: "None" })}
            />
          </div>
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{t("pages.instanceGeneralSettings.censorUsernameInLogs", { defaultValue: "Censor username in logs" })}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t("pages.instanceGeneralSettings.censorUsernameDescription", { defaultValue: "Hide the username segment in home-directory paths and similar operator-visible log output. Standalone username mentions outside of paths are not yet masked in the live transcript view. This is off by default." })}
            </p>
          </div>
          <ToggleSwitch
            checked={censorUsernameInLogs}
            onCheckedChange={() => updateGeneralMutation.mutate({ censorUsernameInLogs: !censorUsernameInLogs })}
            disabled={updateGeneralMutation.isPending || signOutMutation.isPending}
            aria-label={t("pages.instanceGeneralSettings.toggleUsernameLogCensoring", { defaultValue: "Toggle username log censoring" })}
          />
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{t("pages.instanceGeneralSettings.keyboardShortcuts", { defaultValue: "Keyboard shortcuts" })}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t("pages.instanceGeneralSettings.keyboardShortcutsDescription", { defaultValue: "Enable app keyboard shortcuts, including inbox navigation and global shortcuts like creating tasks or toggling panels. This is off by default." })}
            </p>
          </div>
          <ToggleSwitch
            checked={keyboardShortcuts}
            onCheckedChange={() => updateGeneralMutation.mutate({ keyboardShortcuts: !keyboardShortcuts })}
            disabled={updateGeneralMutation.isPending || signOutMutation.isPending}
            aria-label={t("pages.instanceGeneralSettings.toggleKeyboardShortcuts", { defaultValue: "Toggle keyboard shortcuts" })}
          />
        </div>
      </Card>

      <Card className="block p-5">
        <div className="space-y-5">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{t("pages.instanceGeneralSettings.backupRetention", { defaultValue: "Backup retention" })}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t("pages.instanceGeneralSettings.backupRetentionDescription", { defaultValue: "Configure how long automatic database backups are retained. Backups run roughly every hour and are compressed with gzip. Within the daily window all backups are kept; beyond that, one backup per week and one per month are preserved." })}
            </p>
          </div>

          <div className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t("pages.instanceGeneralSettings.daily", { defaultValue: "Daily" })}</h3>
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
                    <div className="text-sm font-medium">{t("pages.instanceGeneralSettings.dayCount", { defaultValue: "{{count}} days", count: days })}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t("pages.instanceGeneralSettings.weekly", { defaultValue: "Weekly" })}</h3>
            <div className="flex flex-wrap gap-2">
              {WEEKLY_RETENTION_PRESETS.map((weeks) => {
                const active = backupRetention.weeklyWeeks === weeks;
                const label = t("pages.instanceGeneralSettings.weekCount", {
                  count: weeks,
                  defaultValue_one: "1 week",
                  defaultValue_other: "{{count}} weeks",
                  defaultValue_few: "{{count}} weeks",
                  defaultValue_many: "{{count}} weeks",
                });
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
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t("pages.instanceGeneralSettings.monthly", { defaultValue: "Monthly" })}</h3>
            <div className="flex flex-wrap gap-2">
              {MONTHLY_RETENTION_PRESETS.map((months) => {
                const active = backupRetention.monthlyMonths === months;
                const label = t("pages.instanceGeneralSettings.monthCount", {
                  count: months,
                  defaultValue_one: "1 month",
                  defaultValue_other: "{{count}} months",
                  defaultValue_few: "{{count}} months",
                  defaultValue_many: "{{count}} months",
                });
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
      </Card>

      <Card className="block p-5">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{t("pages.instanceGeneralSettings.aiFeedbackSharing", { defaultValue: "AI feedback sharing" })}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t("pages.instanceGeneralSettings.aiFeedbackSharingDescription", { defaultValue: "Control whether thumbs up and thumbs down votes can send the voted AI output to Paperclip Labs. Votes are always saved locally." })}
            </p>
            {FEEDBACK_TERMS_URL ? (
              <a
                href={FEEDBACK_TERMS_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
              >
                {t("pages.instanceGeneralSettings.readTermsOfService", { defaultValue: "Read our terms of service" })}
              </a>
            ) : null}
          </div>
          {feedbackDataSharingPreference === "prompt" ? (
            <div className="rounded-lg border border-border/70 bg-accent/20 px-3 py-2 text-sm text-muted-foreground">
              {t("pages.instanceGeneralSettings.noDefaultSavedYet", { defaultValue: "No default is saved yet. The next thumbs up or thumbs down choice will ask once and then save the answer here." })}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {[
              {
                value: "allowed",
                label: t("pages.instanceGeneralSettings.alwaysAllow", { defaultValue: "Always allow" }),
                description: t("pages.instanceGeneralSettings.shareVotedOutputsAutomatically", { defaultValue: "Share voted AI outputs automatically." }),
              },
              {
                value: "not_allowed",
                label: t("pages.instanceGeneralSettings.dontAllow", { defaultValue: "Don't allow" }),
                description: t("pages.instanceGeneralSettings.keepVotedOutputsLocal", { defaultValue: "Keep voted AI outputs local only." }),
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
          <p className="text-xs text-muted-foreground">
            {translateUiLiteral("To retest the first-use prompt in local dev, remove the")}{" "}
            <code>feedbackDataSharingPreference</code>{" "}
            {translateUiLiteral("key from this instance's")}{" "}
            <code>instance_settings.general</code>{" "}
            {translateUiLiteral("JSON row, or set it back to \"prompt\". Unset and \"prompt\" both mean no default has been chosen yet.")}
          </p>
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{t("pages.instanceGeneralSettings.signOut", { defaultValue: "Sign out" })}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t("pages.instanceGeneralSettings.signOutDescription", { defaultValue: "Sign out of this Paperclip instance. You will be redirected to the login page." })}
            </p>
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
            {signOutMutation.isPending ? t("pages.instanceGeneralSettings.signingOut", { defaultValue: "Signing out..." }) : t("pages.instanceGeneralSettings.signOut", { defaultValue: "Sign out" })}
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
