export const EXPERIMENTAL_FEATURE_KEYS = [
  "unauthenticated_login",
  "agent_dual_mode",
  "custom_process_triggers",
] as const;

export type ExperimentalFeatureKey = (typeof EXPERIMENTAL_FEATURE_KEYS)[number];

export interface ExperimentalFeatureDefinition {
  key: ExperimentalFeatureKey;
  title: string;
  description: string;
  warning?: string;
  defaultEnabled: false;
  requiresDevelopmentEnvironment?: boolean;
}

export interface CompanyExperimentalFeaturesConfig {
  enabledFeatures?: Partial<Record<ExperimentalFeatureKey, boolean>>;
}

export interface CompanyConfig {
  experimentalFeatures?: CompanyExperimentalFeaturesConfig;
}

export type CompanyExperimentalFeaturesByCompanyId = Record<string, CompanyExperimentalFeaturesConfig>;

export interface ExperimentalFeatureResolverInput {
  feature: ExperimentalFeatureKey;
  environmentExperimentalModeEnabled: boolean;
  isDevelopmentEnvironment: boolean;
  companyEnabledFeatures?: Partial<Record<ExperimentalFeatureKey, boolean>>;
}

export const PAPERCLIP_EXPERIMENTAL_MODE_ENV = "PAPERCLIP_EXPERIMENTAL_MODE";

export const EXPERIMENTAL_FEATURES: ExperimentalFeatureDefinition[] = [
  {
    key: "unauthenticated_login",
    title: "Unauthenticated login",
    description: "Allows entering the app without signing in for local development and testing.",
    warning: "Only intended for local development. Do not enable in production.",
    defaultEnabled: false,
    requiresDevelopmentEnvironment: true,
  },
  {
    key: "agent_dual_mode",
    title: "Agent dual mode",
    description: "Enables experimental primary/secondary agent routing for development workflows.",
    warning: "Experimental agent routing must remain policy validated.",
    defaultEnabled: false,
    requiresDevelopmentEnvironment: true,
  },
  {
    key: "custom_process_triggers",
    title: "Custom process triggers",
    description: "Enables configurable local process triggers for development integrations.",
    warning: "Do not store secrets or private URLs in process instructions.",
    defaultEnabled: false,
    requiresDevelopmentEnvironment: true,
  },
];

export function isPaperclipExperimentalModeEnabled(
  env: Record<string, string | undefined>,
): boolean {
  return env[PAPERCLIP_EXPERIMENTAL_MODE_ENV] === "true";
}

export function isExperimentalFeatureEnabled(input: ExperimentalFeatureResolverInput): boolean {
  const definition = EXPERIMENTAL_FEATURES.find((feature) => feature.key === input.feature);

  if (!definition) return false;
  if (!input.environmentExperimentalModeEnabled) return false;
  if (definition.requiresDevelopmentEnvironment && !input.isDevelopmentEnvironment) return false;

  return input.companyEnabledFeatures?.[input.feature] === true;
}
