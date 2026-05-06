import type { Agent } from "@paperclipai/shared";
import { isValidAdapterType } from "../adapters/metadata";
import type { CreateConfigValues } from "../components/AgentConfigForm";
import { defaultCreateValues } from "../components/agent-config-defaults";
import {
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
  DEFAULT_CODEX_LOCAL_MODEL,
} from "@paperclipai/adapter-codex-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@paperclipai/adapter-cursor-local";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "@paperclipai/adapter-gemini-local";
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
  } else if (adapterType === "cursor") {
    nextValues.model = DEFAULT_CURSOR_LOCAL_MODEL;
  } else if (adapterType === "opencode_local") {
    nextValues.model = DEFAULT_OPENCODE_LOCAL_MODEL;
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

export function buildNewAgentDefaultCreateValues(input?: {
  companyAgents?: Pick<Agent, "adapterType" | "role">[] | null;
  presetAdapterType?: string | null;
}) {
  return createValuesForAdapterType(resolveNewAgentDefaultAdapterType(input));
}
