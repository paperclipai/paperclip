import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  EXPERIMENTAL_FEATURES,
  HUMAN_COMPANY_MEMBERSHIP_ROLE_LABELS,
  HUMAN_COMPANY_MEMBERSHIP_ROLES,
  type CompanyExperimentalFeaturesConfig,
  type ExperimentalAgentProvider,
  type ExperimentalFeatureDefinition,
  type HumanCompanyMembershipRole,
} from "@paperclipai/shared";
import { agentsApi, type AdapterModel } from "@/api/agents";
import { companiesApi } from "@/api/companies";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";
import {
  isUiExperimentalFeatureEnabled,
  isUiExperimentalModeEnabled,
  UI_EXPERIMENTAL_MODE_ENV,
} from "@/lib/experimental-features";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Field } from "@/components/agent-config-primitives";

const agentProviderOptions: Array<{
  value: ExperimentalAgentProvider;
  label: string;
  adapterType: string;
}> = [
  { value: "claude", label: "Claude", adapterType: "claude_local" },
  { value: "codex", label: "Codex", adapterType: "codex_local" },
];

const selectClassName = "w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none";
const compactSelectClassName = "min-w-32 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none";

const unauthenticatedAccessLevelOptions = HUMAN_COMPANY_MEMBERSHIP_ROLES.map((value) => ({
  value,
  label: HUMAN_COMPANY_MEMBERSHIP_ROLE_LABELS[value],
}));

function adapterTypeForProvider(provider: ExperimentalAgentProvider) {
  return agentProviderOptions.find((option) => option.value === provider)?.adapterType ?? "claude_local";
}

function fallbackProvider(provider: ExperimentalAgentProvider): ExperimentalAgentProvider {
  return provider === "claude" ? "codex" : "claude";
}

function modelOptions(models: AdapterModel[] | undefined, selectedModel?: string | null) {
  const byId = new Map<string, AdapterModel>();
  for (const model of models ?? []) {
    byId.set(model.id, model);
  }
  if (selectedModel && !byId.has(selectedModel)) {
    byId.set(selectedModel, { id: selectedModel, label: selectedModel });
  }
  return Array.from(byId.values());
}

function statusForFeature(input: {
  feature: ExperimentalFeatureDefinition;
  checked: boolean;
  enabled: boolean;
}) {
  if (input.enabled) return "Enabled";
  if (input.checked) return "Configured, inactive";
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
  const currentConfig = experimentalQuery.data?.companyExperimentalFeatures?.[companyId] ?? {};
  const enabledFeatures = currentConfig.enabledFeatures ?? {};

  const mutation = useMutation({
    mutationFn: (nextConfig: CompanyExperimentalFeaturesConfig) =>
      companiesApi.updateExperimentalFeatures(companyId, nextConfig),
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
              !experimentalModeEnabled;
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
                <div className="flex shrink-0 items-start gap-3">
                  <ToggleSwitch
                    checked={checked}
                    disabled={disabled}
                    onCheckedChange={(nextChecked) =>
                      mutation.mutate({
                        ...currentConfig,
                        enabledFeatures: {
                          ...enabledFeatures,
                          [feature.key]: nextChecked,
                        },
                      })
                    }
                    aria-label={`Toggle ${feature.title}`}
                  />
                  {feature.key === "unauthenticated_login" && (
                    <label className="space-y-1 text-xs text-muted-foreground">
                      <span>Access level</span>
                      <select
                        className={compactSelectClassName}
                        value={currentConfig.unauthenticatedLogin?.accessLevel ?? "viewer"}
                        disabled={disabled}
                        onChange={(event) =>
                          mutation.mutate({
                            ...currentConfig,
                            enabledFeatures,
                            unauthenticatedLogin: {
                              ...(currentConfig.unauthenticatedLogin ?? {}),
                              accessLevel: event.target.value as HumanCompanyMembershipRole,
                            },
                          })
                        }
                        aria-label="Join without login access level"
                      >
                        {unauthenticatedAccessLevelOptions.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <DualModeAgentRoutingConfig
          companyId={companyId}
          currentConfig={currentConfig}
          experimentalModeEnabled={experimentalModeEnabled}
          loading={experimentalQuery.isLoading}
          saving={mutation.isPending}
          onChange={(agentDualMode) =>
            mutation.mutate({
              ...currentConfig,
              enabledFeatures,
              agentDualMode,
            })
          }
        />

        {mutation.error && (
          <div className="text-sm text-destructive">
            {mutation.error instanceof Error ? mutation.error.message : "Failed to update experimental features."}
          </div>
        )}
      </div>
    </div>
  );
}

function DualModeAgentRoutingConfig({
  companyId,
  currentConfig,
  experimentalModeEnabled,
  loading,
  saving,
  onChange,
}: {
  companyId: string;
  currentConfig: CompanyExperimentalFeaturesConfig;
  experimentalModeEnabled: boolean;
  loading: boolean;
  saving: boolean;
  onChange: (agentDualMode: NonNullable<CompanyExperimentalFeaturesConfig["agentDualMode"]>) => void;
}) {
  const config = currentConfig.agentDualMode ?? {};
  const primaryAgent = config.primaryAgent ?? "claude";
  const secondaryAgent =
    config.secondaryAgent && config.secondaryAgent !== primaryAgent
      ? config.secondaryAgent
      : fallbackProvider(primaryAgent);
  const dualModeConfigured = currentConfig.enabledFeatures?.agent_dual_mode === true;
  const dualModeActive = isUiExperimentalFeatureEnabled("agent_dual_mode", currentConfig);
  const controlsDisabled =
    saving ||
    loading ||
    !experimentalModeEnabled ||
    !dualModeConfigured;

  const claudeModelsQuery = useQuery({
    queryKey: queryKeys.agents.adapterModels(companyId, "claude_local"),
    queryFn: () => agentsApi.adapterModels(companyId, "claude_local"),
    enabled: !!companyId,
    retry: false,
  });
  const codexModelsQuery = useQuery({
    queryKey: queryKeys.agents.adapterModels(companyId, "codex_local"),
    queryFn: () => agentsApi.adapterModels(companyId, "codex_local"),
    enabled: !!companyId,
    retry: false,
  });

  const selectedClaudeModel =
    primaryAgent === "claude"
      ? config.primaryModel
      : secondaryAgent === "claude"
        ? config.secondaryModel
        : null;
  const selectedCodexModel =
    primaryAgent === "codex"
      ? config.primaryModel
      : secondaryAgent === "codex"
        ? config.secondaryModel
        : null;

  const modelsByProvider = useMemo(
    () => ({
      claude: modelOptions(claudeModelsQuery.data, selectedClaudeModel),
      codex: modelOptions(codexModelsQuery.data, selectedCodexModel),
    }),
    [
      claudeModelsQuery.data,
      codexModelsQuery.data,
      selectedClaudeModel,
      selectedCodexModel,
    ],
  );

  function updateConfig(nextConfig: NonNullable<CompanyExperimentalFeaturesConfig["agentDualMode"]>) {
    onChange({
      primaryAgent,
      primaryModel: config.primaryModel ?? null,
      secondaryAgent,
      secondaryModel: config.secondaryModel ?? null,
      ...nextConfig,
    });
  }

  const modelLoadFailed = claudeModelsQuery.isError || codexModelsQuery.isError;

  return (
    <div className="border-t border-border pt-4">
      <div className="mb-3 space-y-1">
        <h3 className="text-sm font-medium">Dual-mode routing config</h3>
        <p className="text-sm text-muted-foreground">
          Choose the primary and secondary local agent providers and model overrides used when the dual-mode flag is
          active.
        </p>
      </div>

      {!dualModeConfigured && (
        <div className="mb-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          Enable Dual-mode agent routing above to edit routing configuration.
        </div>
      )}
      {dualModeConfigured && !dualModeActive && (
        <div className="mb-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          Dual-mode routing is configured but inactive until the environment master flag and company flag both pass.
        </div>
      )}
      {modelLoadFailed && (
        <div className="mb-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          Some adapter models could not be loaded. Existing saved model values are still shown.
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Primary agent" hint="The provider used first when dual-mode routing is active.">
          <select
            className={selectClassName}
            value={primaryAgent}
            disabled={controlsDisabled}
            onChange={(event) => {
              const nextPrimaryAgent = event.target.value as ExperimentalAgentProvider;
              updateConfig({
                primaryAgent: nextPrimaryAgent,
                primaryModel: null,
                secondaryAgent:
                  nextPrimaryAgent === secondaryAgent ? fallbackProvider(nextPrimaryAgent) : secondaryAgent,
              });
            }}
          >
            {agentProviderOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </Field>

        <Field label="Primary model" hint="Optional model override for the primary provider.">
          <ModelSelect
            disabled={controlsDisabled}
            models={modelsByProvider[primaryAgent]}
            value={config.primaryModel ?? ""}
            adapterType={adapterTypeForProvider(primaryAgent)}
            onChange={(primaryModel) => updateConfig({ primaryModel })}
          />
        </Field>

        <Field label="Secondary agent" hint="The provider used when policy allows fallback from the primary provider.">
          <select
            className={selectClassName}
            value={secondaryAgent}
            disabled={controlsDisabled}
            onChange={(event) => {
              const nextSecondaryAgent = event.target.value as ExperimentalAgentProvider;
              updateConfig({
                secondaryAgent: nextSecondaryAgent,
                secondaryModel: null,
                primaryAgent:
                  nextSecondaryAgent === primaryAgent ? fallbackProvider(nextSecondaryAgent) : primaryAgent,
              });
            }}
          >
            {agentProviderOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </Field>

        <Field label="Secondary model" hint="Optional model override for the secondary provider.">
          <ModelSelect
            disabled={controlsDisabled}
            models={modelsByProvider[secondaryAgent]}
            value={config.secondaryModel ?? ""}
            adapterType={adapterTypeForProvider(secondaryAgent)}
            onChange={(secondaryModel) => updateConfig({ secondaryModel })}
          />
        </Field>
      </div>
    </div>
  );
}

function ModelSelect({
  disabled,
  models,
  value,
  adapterType,
  onChange,
}: {
  disabled: boolean;
  models: AdapterModel[];
  value: string;
  adapterType: string;
  onChange: (value: string | null) => void;
}) {
  return (
    <select
      className={selectClassName}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value || null)}
    >
      <option value="">Adapter default</option>
      {models.map((model) => (
        <option key={`${adapterType}:${model.id}`} value={model.id}>
          {model.label || model.id}
        </option>
      ))}
    </select>
  );
}
