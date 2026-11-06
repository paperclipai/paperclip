import { z } from "zod";

export const PLUGIN_RUN_CONFIGURATION_CAPABILITY = "agent.runs.configure" as const;

export const PLUGIN_RUN_ADAPTER_CONFIG_KEYS = ["model", "effort", "modelReasoningEffort", "reasoningEffort", "variant"] as const;
export type PluginRunAdapterConfigKey = (typeof PLUGIN_RUN_ADAPTER_CONFIG_KEYS)[number];
export type PluginRunAdapterConfig = Partial<Record<PluginRunAdapterConfigKey, string>>;

const modelValueSchema = z.string().trim().min(1).max(256);
const effortValueSchema = z.string().trim().min(1).max(32);

export const pluginRunAdapterConfigSchema = z.object({
  model: modelValueSchema.optional(),
  effort: effortValueSchema.optional(),
  modelReasoningEffort: effortValueSchema.optional(),
  reasoningEffort: effortValueSchema.optional(),
  variant: effortValueSchema.optional(),
}).strict();

export const pluginPrepareAgentRunResultSchema = z.object({
  adapterConfig: pluginRunAdapterConfigSchema.nullable().optional(),
  reason: z.string().trim().max(500).optional(),
}).strict().nullable();

export interface PluginPrepareAgentRunRequest {
  companyId: string;
  agentId: string;
  runId: string;
  adapterType: string;
  invocationSource: string;
  wakeReason: string | null;
  retryAttempt: number;
  issueId: string | null;
  issue: { id: string; identifier: string | null; title: string; description: string | null } | null;
  adapterConfig: PluginRunAdapterConfig;
  issueOverrides: PluginRunAdapterConfig;
}

export type PluginPrepareAgentRunResult = z.infer<typeof pluginPrepareAgentRunResultSchema>;

export function pickPluginRunAdapterConfig(config: Record<string, unknown> | null | undefined): PluginRunAdapterConfig {
  const picked: PluginRunAdapterConfig = {};
  for (const key of PLUGIN_RUN_ADAPTER_CONFIG_KEYS) {
    const value = config?.[key];
    if (typeof value === "string" && value.trim().length > 0) picked[key] = value;
  }
  return picked;
}
