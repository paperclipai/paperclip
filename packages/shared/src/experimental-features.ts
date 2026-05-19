import type { HumanCompanyMembershipRole } from "./constants.js";

export const EXPERIMENTAL_FEATURE_KEYS = [
  "unauthenticated_login",
  "agent_dual_mode",
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

export type ExperimentalAgentProvider = "claude" | "codex";

export interface ExperimentalAgentDualModeConfig {
  primaryAgent?: ExperimentalAgentProvider;
  primaryModel?: string | null;
  secondaryAgent?: ExperimentalAgentProvider;
  secondaryModel?: string | null;
}

export interface ExperimentalUnauthenticatedLoginConfig {
  accessLevel?: HumanCompanyMembershipRole;
}

export interface CompanyExperimentalFeaturesConfig {
  enabledFeatures?: Partial<Record<ExperimentalFeatureKey, boolean>>;
  unauthenticatedLogin?: ExperimentalUnauthenticatedLoginConfig;
  agentDualMode?: ExperimentalAgentDualModeConfig;
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
    title: "Join without login",
    description: "Allows entering the app without signing in when explicitly enabled for this company.",
    warning: "Only available when PAPERCLIP_EXPERIMENTAL_MODE is enabled for this environment.",
    defaultEnabled: false,
    requiresDevelopmentEnvironment: true,
  },
  {
    key: "agent_dual_mode",
    title: "Dual-mode agent routing",
    description: "Enables experimental primary/secondary agent routing when explicitly enabled for this company.",
    warning: "Experimental agent routing must remain policy validated.",
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

  return input.companyEnabledFeatures?.[input.feature] === true;
}
