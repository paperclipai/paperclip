import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  EXPERIMENTAL_FEATURES,
  type ExperimentalFeatureDefinition,
  type ExperimentalFeatureKey,
} from "@paperclipai/shared";
import { companiesApi } from "@/api/companies";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";
import {
  isUiExperimentalFeatureEnabled,
  isUiExperimentalModeEnabled,
  UI_EXPERIMENTAL_MODE_ENV,
} from "@/lib/experimental-features";
import { ToggleSwitch } from "@/components/ui/toggle-switch";

function statusForFeature(input: {
  feature: ExperimentalFeatureDefinition;
  checked: boolean;
  enabled: boolean;
}) {
  if (input.enabled) return "Enabled";
  if (input.checked) return "Configured, inactive";
  if (input.feature.requiresDevelopmentEnvironment && !import.meta.env.DEV) {
    return "Development only";
  }
  return "Off";
}

export function ExperimentalFeaturesSettings({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const experimentalModeEnabled = isUiExperimentalModeEnabled();
  const experimentalQuery = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    retry: false,
  });
  const currentConfig = experimentalQuery.data?.companyExperimentalFeatures[companyId] ?? {};
  const enabledFeatures = currentConfig.enabledFeatures ?? {};

  const mutation = useMutation({
    mutationFn: (nextEnabledFeatures: Partial<Record<ExperimentalFeatureKey, boolean>>) =>
      companiesApi.updateExperimentalFeatures(companyId, {
        enabledFeatures: nextEnabledFeatures,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.instance.experimentalSettings,
      });
    },
  });

  return (
    <div className="space-y-4" data-testid="company-settings-experimental-features-section">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Experimental features
      </div>
      <div className="space-y-4 rounded-md border border-border px-4 py-4">
        <p className="text-sm text-muted-foreground">
          Enable experimental features for this company. These features may be unstable and are intended for development
          or local testing.
        </p>

        {!experimentalModeEnabled && (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            Experimental mode is disabled by environment configuration. Enable {UI_EXPERIMENTAL_MODE_ENV} to use these
            flags.
          </div>
        )}

        {experimentalQuery.error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {experimentalQuery.error instanceof Error
              ? experimentalQuery.error.message
              : "Failed to load experimental features."}
          </div>
        )}

        <div className="divide-y divide-border">
          {EXPERIMENTAL_FEATURES.map((feature) => {
            const checked = enabledFeatures[feature.key] === true;
            const enabled = isUiExperimentalFeatureEnabled(feature.key, currentConfig);
            const disabled =
              mutation.isPending ||
              experimentalQuery.isLoading ||
              !experimentalModeEnabled ||
              (feature.requiresDevelopmentEnvironment === true && !import.meta.env.DEV);
            return (
              <div key={feature.key} className="flex items-start justify-between gap-4 py-4 first:pt-0 last:pb-0">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-medium">{feature.title}</h3>
                    <span className="rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      {statusForFeature({ feature, checked, enabled })}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground">{feature.description}</p>
                  {feature.warning && (
                    <p className="text-xs text-amber-700 dark:text-amber-300">{feature.warning}</p>
                  )}
                </div>
                <ToggleSwitch
                  checked={checked}
                  disabled={disabled}
                  onCheckedChange={(nextChecked) =>
                    mutation.mutate({
                      ...enabledFeatures,
                      [feature.key]: nextChecked,
                    })
                  }
                  aria-label={`Toggle ${feature.title}`}
                />
              </div>
            );
          })}
        </div>

        {mutation.error && (
          <div className="text-sm text-destructive">
            {mutation.error instanceof Error ? mutation.error.message : "Failed to update experimental features."}
          </div>
        )}
      </div>
    </div>
  );
}
