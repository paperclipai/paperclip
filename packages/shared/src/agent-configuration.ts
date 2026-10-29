import { z } from "zod";
import { resolveAgentAppearance } from "./agent-appearance.js";
import type { Agent } from "./types/agent.js";
import { createAgentSchema } from "./validators/agent.js";
import { objectWithoutDefaults } from "./validators/partial.js";
import { agentConfigurationResourceShape } from "./agent-configuration-resources.js";

export const agentConfigurationSpecSchema = objectWithoutDefaults(createAgentSchema.pick({
  name: true,
  role: true,
  title: true,
  icon: true,
  appearance: true,
  reportsTo: true,
  capabilities: true,
  adapterType: true,
  adapterConfig: true,
  runtimeConfig: true,
  defaultEnvironmentId: true,
  budgetMonthlyCents: true,
  metadata: true,
})).required().strict();

export const agentConfigurationDocumentSchema = z.object({
  apiVersion: z.literal("paperclip/v1"),
  kind: z.literal("Agent"),
  spec: agentConfigurationSpecSchema.extend(agentConfigurationResourceShape),
  observed: z.record(z.string(), z.unknown()).optional(),
}).strict();

export type AgentConfigurationSpec = z.infer<typeof agentConfigurationSpecSchema>;
export type AgentConfigurationDocument = z.infer<typeof agentConfigurationDocumentSchema>;
export type AgentConfigurationSource = Omit<Pick<Agent, "id" | keyof AgentConfigurationSpec>, "role" | "adapterType"> & {
  role: string;
  adapterType: string;
};
export type AgentConfigurationResponse = AgentConfigurationSource & { configurationRevision: string };

export function agentConfigurationSpec(agent: AgentConfigurationSource) {
  return {
    name: agent.name,
    role: agent.role,
    title: agent.title,
    icon: agent.icon,
    appearance: resolveAgentAppearance(agent.appearance, agent.id),
    reportsTo: agent.reportsTo,
    capabilities: agent.capabilities,
    adapterType: agent.adapterType,
    adapterConfig: agent.adapterConfig,
    runtimeConfig: agent.runtimeConfig,
    defaultEnvironmentId: agent.defaultEnvironmentId ?? null,
    budgetMonthlyCents: agent.budgetMonthlyCents,
    metadata: agent.metadata,
  };
}

export function canonicalAgentConfiguration(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
}
