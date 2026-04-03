import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PatchInstanceGeneralSettings } from "@penclipai/shared";
import { SlidersHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

const FEEDBACK_TERMS_URL = import.meta.env.VITE_FEEDBACK_TERMS_URL?.trim() || "https://paperclip.ing/tos";

export function InstanceGeneralSettings() {
  const { t } = useTranslation();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: t("Instance Settings", { defaultValue: "Instance Settings" }) },
      { label: t("General", { defaultValue: "General" }) },
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
      setActionError(
        error instanceof Error
          ? error.message
          : t("Failed to update general settings.", { defaultValue: "Failed to update general settings." }),
      );
    },
  });

  if (generalQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">{t("Loading general settings...", { defaultValue: "Loading general settings..." })}</div>;
  }

  if (generalQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {generalQuery.error instanceof Error
          ? generalQuery.error.message
          : t("Failed to load general settings.", { defaultValue: "Failed to load general settings." })}
      </div>
    );
  }

  const censorUsernameInLogs = generalQuery.data?.censorUsernameInLogs === true;
  const keyboardShortcuts = generalQuery.data?.keyboardShortcuts === true;
  const feedbackDataSharingPreference = generalQuery.data?.feedbackDataSharingPreference ?? "prompt";

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t("General", { defaultValue: "General" })}</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {t(
            "Configure instance-wide defaults that affect how operator-visible logs are displayed.",
            { defaultValue: "Configure instance-wide defaults that affect how operator-visible logs are displayed." },
          )}
        </p>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{t("Censor username in logs", { defaultValue: "Censor username in logs" })}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t(
                "Hide the username segment in home-directory paths and similar operator-visible log output. Standalone username mentions outside of paths are not yet masked in the live transcript view. This is off by default.",
                {
                  defaultValue:
                    "Hide the username segment in home-directory paths and similar operator-visible log output. Standalone username mentions outside of paths are not yet masked in the live transcript view. This is off by default.",
                },
              )}
            </p>
          </div>
          <button
            type="button"
            data-slot="toggle"
            aria-label={t("Toggle username log censoring", { defaultValue: "Toggle username log censoring" })}
            disabled={updateGeneralMutation.isPending}
            className={cn(
              "relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60",
              censorUsernameInLogs ? "bg-green-600" : "bg-muted",
            )}
            onClick={() =>
              updateGeneralMutation.mutate({
                censorUsernameInLogs: !censorUsernameInLogs,
              })
            }
          >
            <span
              className={cn(
                "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
                censorUsernameInLogs ? "translate-x-4.5" : "translate-x-0.5",
              )}
            />
          </button>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">
              {t("instanceGeneralSettings.keyboardShortcutsTitle")}
            </h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t("instanceGeneralSettings.keyboardShortcutsDescription")}
            </p>
          </div>
          <button
            type="button"
            data-slot="toggle"
            aria-label={t("instanceGeneralSettings.keyboardShortcutsToggle")}
            disabled={updateGeneralMutation.isPending}
            className={cn(
              "relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60",
              keyboardShortcuts ? "bg-green-600" : "bg-muted",
            )}
            onClick={() => updateGeneralMutation.mutate({ keyboardShortcuts: !keyboardShortcuts })}
          >
            <span
              className={cn(
                "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
                keyboardShortcuts ? "translate-x-4.5" : "translate-x-0.5",
              )}
            />
          </button>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{t("instanceGeneralSettings.feedbackSharingTitle")}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t("instanceGeneralSettings.feedbackSharingDescription")}
            </p>
            {FEEDBACK_TERMS_URL ? (
              <a
                href={FEEDBACK_TERMS_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
              >
                {t("outputFeedback.readTerms")}
              </a>
            ) : null}
          </div>
          {feedbackDataSharingPreference === "prompt" ? (
            <div className="rounded-lg border border-border/70 bg-accent/20 px-3 py-2 text-sm text-muted-foreground">
              {t("instanceGeneralSettings.feedbackSharingPromptNotice")}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {[
              {
                value: "allowed",
                label: t("outputFeedback.alwaysAllow"),
                description: t("instanceGeneralSettings.feedbackSharingAlwaysAllowDescription"),
              },
              {
                value: "not_allowed",
                label: t("outputFeedback.dontAllow"),
                description: t("instanceGeneralSettings.feedbackSharingDontAllowDescription"),
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
            {t("instanceGeneralSettings.feedbackSharingRetestPrefix")}{" "}
            <code>feedbackDataSharingPreference</code>{" "}
            {t("instanceGeneralSettings.feedbackSharingRetestMiddle")}{" "}
            <code>instance_settings.general</code>{" "}
            {t("instanceGeneralSettings.feedbackSharingRetestSuffix")} <code>"prompt"</code>.{" "}
            {t("instanceGeneralSettings.feedbackSharingRetestExplanation")}
          </p>
        </div>
      </section>
    </div>
  );
}
