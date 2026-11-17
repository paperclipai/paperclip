import { z } from "zod";
import type { AppDefinition } from "./types/app-definition.js";

export const CONNECTION_INSTRUCTIONS_MAX_LENGTH = 2000;

/** Optional catalog capability. It is independent of provider and transport. */
export const connectionInstructionTemplateSchema = z.object({
  id: z.string().trim().min(1).max(160),
  version: z.number().int().positive(),
  text: z.string().trim().min(1).max(CONNECTION_INSTRUCTIONS_MAX_LENGTH),
});
export type ConnectionInstructionTemplate = z.infer<typeof connectionInstructionTemplateSchema>;

/** Connection-owned settings; custom connections need not have a template. */
export const connectionAgentInstructionsSchema = z.object({
  enabled: z.boolean(),
  text: z.string().trim().min(1).max(CONNECTION_INSTRUCTIONS_MAX_LENGTH),
  template: z.object({
    id: z.string().trim().min(1).max(160),
    version: z.number().int().positive(),
  }).optional(),
});
export type ConnectionAgentInstructions = z.infer<typeof connectionAgentInstructionsSchema>;

export function defaultConnectionAgentInstructions(
  template: ConnectionInstructionTemplate | null | undefined,
): ConnectionAgentInstructions | null {
  return template ? {
    enabled: true,
    text: template.text,
    template: { id: template.id, version: template.version },
  } : null;
}

/** The server supplies this immutable snapshot, never the wake request author. */
export interface ConnectionInstructionsSnapshot {
  text: string;
  digest: string;
}

/** Older connections can retain catalog metadata only in transportConfig. */
export function connectionInstructionsConfig(connection: {
  config?: Record<string, unknown> | null;
  transportConfig?: Record<string, unknown> | null;
}): Record<string, unknown> {
  return { ...connection.transportConfig, ...connection.config };
}

/** Only public configuration fields declared by the connector enter prompts. */
export function connectionInstructionContext(
  app: AppDefinition | null | undefined,
  config: Record<string, unknown>,
): Record<string, string | boolean> | null {
  const method = app?.methods.find((entry) => entry.key === config.connectionMethodKey) ?? app?.methods[0];
  const values = config.methodConfig && typeof config.methodConfig === "object" && !Array.isArray(config.methodConfig)
    ? config.methodConfig as Record<string, unknown> : {};
  const context: Record<string, string | boolean> = {};
  for (const field of [...(method?.tenantFields ?? []), ...(method?.extensionFields ?? [])]) {
    if (field.secret || field.type === "password") continue;
    const value = values[field.key] ?? field.defaultValue;
    if (field.required && (value === undefined || value === null || (typeof value === "string" && !value.trim()))) return null;
    if (typeof value === "string" && value.trim()) context[field.key] = value.trim();
    else if (typeof value === "boolean") context[field.key] = value;
  }
  return context;
}
