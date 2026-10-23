import type { Agent } from "@paperclipai/shared";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { isValidAdapterType } from "../adapters/metadata";
import { defaultCreateValues } from "../components/agent-config-defaults";
import {
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
  DEFAULT_CODEX_LOCAL_MODEL,
} from "@paperclipai/adapter-codex-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@paperclipai/adapter-cursor-local";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "@paperclipai/adapter-gemini-local";
import { DEFAULT_KIMI_LOCAL_MODEL } from "@paperclipai/adapter-kimi-local";
import { DEFAULT_OPENCODE_LOCAL_MODEL } from "@paperclipai/adapter-opencode-local";

export function createValuesForAdapterType(
  adapterType: CreateConfigValues["adapterType"],
): CreateConfigValues {
  const { adapterType: _discard, ...defaults } = defaultCreateValues;
  const nextValues: CreateConfigValues = { ...defaults, adapterType };
  if (adapterType === "codex_local") {
    nextValues.model = DEFAULT_CODEX_LOCAL_MODEL;
    nextValues.dangerouslyBypassSandbox =
      DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX;
  } else if (adapterType === "gemini_local") {
    nextValues.model = DEFAULT_GEMINI_LOCAL_MODEL;
  } else if (adapterType === "kimi_local") {
    nextValues.model = DEFAULT_KIMI_LOCAL_MODEL;
  } else if (adapterType === "cursor") {
    nextValues.model = DEFAULT_CURSOR_LOCAL_MODEL;
  } else if (adapterType === "opencode_local") {
    nextValues.model = DEFAULT_OPENCODE_LOCAL_MODEL;
  } else if (adapterType === "paperclip_runner") {
    nextValues.model = DEFAULT_CODEX_LOCAL_MODEL;
  }
  return nextValues;
}

export function resolveNewAgentDefaultAdapterType(input?: {
  companyAgents?: Pick<Agent, "adapterType" | "role">[] | null;
  presetAdapterType?: string | null;
}) {
  const presetAdapterType = input?.presetAdapterType;
  if (typeof presetAdapterType === "string" && isValidAdapterType(presetAdapterType)) {
    return presetAdapterType as CreateConfigValues["adapterType"];
  }

  const ceoAdapterType = input?.companyAgents?.find((agent) => agent.role === "ceo")?.adapterType ?? null;
  if (typeof ceoAdapterType === "string" && isValidAdapterType(ceoAdapterType)) {
    return ceoAdapterType as CreateConfigValues["adapterType"];
  }

  return defaultCreateValues.adapterType;
}

/**
 * Harnesses the new-agent picker offers for `paperclip_runner`. The picker and
 * the default-selection logic must agree on this set, otherwise an inherited
 * CEO harness cannot be shown or submitted.
 */
export const NEW_AGENT_RUNNER_PROVIDERS = [
  { value: "grok", label: "Grok Build (Paperclip Runner)" },
  { value: "opencode", label: "OpenCode (Paperclip Runner)" },
] as const;

export type NewAgentRunnerProvider = (typeof NEW_AGENT_RUNNER_PROVIDERS)[number]["value"];

type RunnerProviderAgent = Pick<Agent, "adapterType" | "role"> & {
  adapterConfig?: Record<string, unknown> | null;
};

function isOfferedRunnerProvider(
  value: unknown,
  allowedProviders: readonly string[],
): value is string {
  return typeof value === "string" && allowedProviders.includes(value);
}

/**
 * Resolves the harness for an inherited `paperclip_runner` default. ACPX
 * harnesses are stored as `provider: "acpx"` plus `acpxAgent`, so the agent
 * value is read as a fallback. Never returns a harness the picker does not
 * offer, so submission can never save an unroutable provider.
 */
export function resolveNewAgentDefaultRunnerProvider(input?: {
  companyAgents?: RunnerProviderAgent[] | null;
  presetRunnerProvider?: string | null;
  allowedProviders?: readonly string[];
}): string {
  const allowedProviders = input?.allowedProviders?.length
    ? input.allowedProviders
    : NEW_AGENT_RUNNER_PROVIDERS.map((offered) => offered.value as string);
  const isOffered = (value: unknown) => isOfferedRunnerProvider(value, allowedProviders);

  const presetRunnerProvider = input?.presetRunnerProvider;
  if (isOffered(presetRunnerProvider)) return presetRunnerProvider;

  const adapterConfig = input?.companyAgents?.find((agent) => agent.role === "ceo")?.adapterConfig;
  const provider = adapterConfig?.provider;
  if (isOffered(provider)) return provider;
  const acpxAgent = adapterConfig?.acpxAgent;
  if (provider === "acpx" && isOffered(acpxAgent)) return acpxAgent;

  return allowedProviders[0] ?? NEW_AGENT_RUNNER_PROVIDERS[0].value;
}

export function buildNewAgentDefaultCreateValues(input?: {
  companyAgents?: Pick<Agent, "adapterType" | "role">[] | null;
  presetAdapterType?: string | null;
}) {
  return createValuesForAdapterType(resolveNewAgentDefaultAdapterType(input));
}
