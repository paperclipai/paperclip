import type { AgentDetail } from "@paperclipai/shared";

const INSTRUCTION_CONFIG_KEYS = [
  "instructionsBundleMode",
  "instructionsRootPath",
  "instructionsEntryFile",
  "instructionsFilePath",
  "agentsMdPath",
  "promptTemplate",
  "bootstrapPromptTemplate",
] as const;

export type DuplicateInstructionsBundle = {
  entryFile: string;
  files: Record<string, string>;
};

type DuplicateAgentSource = Pick<
  AgentDetail,
  | "name"
  | "role"
  | "title"
  | "icon"
  | "reportsTo"
  | "capabilities"
  | "adapterType"
  | "adapterConfig"
  | "runtimeConfig"
  | "defaultEnvironmentId"
  | "budgetMonthlyCents"
  | "permissions"
  | "metadata"
>;

function cloneRecord(value: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!value) return {};
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export function duplicateAgentName(name: string): string {
  const trimmed = name.trim();
  return `${trimmed || "Agent"} Copy`;
}

export function buildDuplicateAgentPayload(
  agent: DuplicateAgentSource,
  instructionsBundle?: DuplicateInstructionsBundle | null,
): Record<string, unknown> {
  const adapterConfig = cloneRecord(agent.adapterConfig);
  for (const key of INSTRUCTION_CONFIG_KEYS) {
    delete adapterConfig[key];
  }

  const payload: Record<string, unknown> = {
    name: duplicateAgentName(agent.name),
    role: agent.role,
    adapterType: agent.adapterType,
    adapterConfig,
    runtimeConfig: cloneRecord(agent.runtimeConfig),
    defaultEnvironmentId: agent.defaultEnvironmentId ?? null,
    budgetMonthlyCents: agent.budgetMonthlyCents ?? 0,
    permissions: {
      canCreateAgents: Boolean(agent.permissions?.canCreateAgents),
    },
  };

  if (agent.title) payload.title = agent.title;
  if (agent.icon) payload.icon = agent.icon;
  if (agent.reportsTo) payload.reportsTo = agent.reportsTo;
  if (agent.capabilities) payload.capabilities = agent.capabilities;
  if (agent.metadata) payload.metadata = cloneRecord(agent.metadata);

  if (instructionsBundle && Object.keys(instructionsBundle.files).length > 0) {
    payload.instructionsBundle = instructionsBundle;
  }

  return payload;
}
