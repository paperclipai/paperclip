import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { FlaskConical } from "lucide-react";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { i18n, LANGUAGE_STORAGE_KEY, SUPPORTED_LANGUAGES, type SupportedLanguage } from "../i18n/config";

export function InstanceExperimentalSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [currentLang, setCurrentLang] = useState<SupportedLanguage>(
    (i18n.language as SupportedLanguage) ?? "en",
  );

  useEffect(() => {
    setBreadcrumbs([
      { label: t("pages.instanceSettings.title") },
      { label: t("pages.instanceExperimentalSettings.title") },
    ]);
  }, [setBreadcrumbs, t]);

  function handleLanguageChange(lang: SupportedLanguage) {
    setCurrentLang(lang);
    i18n.changeLanguage(lang);
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
    } catch {
      // Ignore localStorage errors.
    }
  }

  const experimentalQuery = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });

  const toggleMutation = useMutation({
    mutationFn: async (enabled: boolean) =>
      instanceSettingsApi.updateExperimental({ enableIsolatedWorkspaces: enabled }),
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.experimentalSettings });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to update experimental settings.");
    },
  });

  if (experimentalQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">{t("common.loading")}</div>;
  }

  if (experimentalQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {experimentalQuery.error instanceof Error
          ? experimentalQuery.error.message
          : "Failed to load experimental settings."}
      </div>
    );
  }

  const enableIsolatedWorkspaces = experimentalQuery.data?.enableIsolatedWorkspaces === true;

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <FlaskConical className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t("pages.instanceExperimentalSettings.title")}</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Opt into features that are still being evaluated before they become default behavior.
        </p>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      {/* Language Selector */}
      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{t("pages.instanceExperimentalSettings.language")}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t("pages.instanceExperimentalSettings.languageDescription")}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {SUPPORTED_LANGUAGES.map((lang) => (
              <button
                key={lang.value}
                type="button"
                onClick={() => handleLanguageChange(lang.value)}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium rounded-md border transition-colors",
                  currentLang === lang.value
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-transparent text-muted-foreground border-border hover:bg-accent/50 hover:text-foreground",
                )}
              >
                {lang.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Enabled Isolated Workspaces</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Show execution workspace controls in project configuration and allow isolated workspace behavior for new
              and existing issue runs.
            </p>
          </div>
          <button
            type="button"
            aria-label="Toggle isolated workspaces experimental setting"
            disabled={toggleMutation.isPending}
            className={cn(
              "relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60",
              enableIsolatedWorkspaces ? "bg-green-600" : "bg-muted",
            )}
            onClick={() => toggleMutation.mutate(!enableIsolatedWorkspaces)}
          >
            <span
              className={cn(
                "inline-block h-4.5 w-4.5 rounded-full bg-white transition-transform",
                enableIsolatedWorkspaces ? "translate-x-6" : "translate-x-0.5",
              )}
            />
          </button>
        </div>
      </section>
    </div>
  );
}
