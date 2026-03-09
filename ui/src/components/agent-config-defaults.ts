import {
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
  DEFAULT_CODEX_LOCAL_MODEL,
} from "@paperclipai/adapter-codex-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@paperclipai/adapter-cursor-local";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import type { Agent } from "@paperclipai/shared";

export const defaultCreateValues: CreateConfigValues = {
  adapterType: "claude_local",
  cwd: "",
  instructionsFilePath: "",
  promptTemplate: "",
  model: "",
  thinkingEffort: "",
  chrome: false,
  dangerouslySkipPermissions: false,
  search: false,
  dangerouslyBypassSandbox: false,
  command: "",
  args: "",
  extraArgs: "",
  envVars: "",
  envBindings: {},
  url: "",
  bootstrapPrompt: "",
  maxTurnsPerRun: 80,
  heartbeatEnabled: false,
  intervalSec: 300,
};

export const DEFAULT_SPECIALIST_CREATE_ADAPTER_TYPE = "codex_local";

export function createDefaultCreateValues(
  adapterType: CreateConfigValues["adapterType"] = DEFAULT_SPECIALIST_CREATE_ADAPTER_TYPE,
): CreateConfigValues {
  const nextValues: CreateConfigValues = {
    ...defaultCreateValues,
    adapterType,
    model: "",
    dangerouslyBypassSandbox: false,
  };

  if (adapterType === "codex_local") {
    nextValues.model = DEFAULT_CODEX_LOCAL_MODEL;
    nextValues.dangerouslyBypassSandbox =
      DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX;
  } else if (adapterType === "cursor") {
    nextValues.model = DEFAULT_CURSOR_LOCAL_MODEL;
  }

  return nextValues;
}

type AgentManagerCandidate = Pick<Agent, "id" | "role" | "reportsTo" | "status">;

export function resolveDefaultManagerId(
  agents: readonly AgentManagerCandidate[],
): string | null {
  const ceos = agents.filter((agent) => agent.role === "ceo" && agent.status !== "terminated");
  if (ceos.length === 0) return null;
  return ceos.find((agent) => agent.reportsTo === null)?.id ?? ceos[0]!.id;
}
