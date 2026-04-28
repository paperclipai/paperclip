import { z } from "zod";
import { AGENT_ROLES, AGENT_ICON_NAMES } from "../constants.js";
import { agentAdapterTypeSchema } from "../adapter-type.js";

export const createAgentBlueprintSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  role: z.enum(AGENT_ROLES).optional().default("general"),
  title: z.string().optional().nullable(),
  icon: z.enum(AGENT_ICON_NAMES).optional().nullable(),
  capabilities: z.string().optional().nullable(),
  tags: z.array(z.string().min(1)).optional().default([]),
  adapterType: agentAdapterTypeSchema,
  adapterConfig: z.record(z.unknown()).optional().default({}),
  runtimeConfig: z.record(z.unknown()).optional().default({}),
  budgetMonthlyCents: z.number().int().nonnegative().optional().default(0),
  permissions: z.record(z.unknown()).optional().default({}),
  instructionsContent: z.string().optional().nullable(),
  metadata: z.record(z.unknown()).optional().nullable(),
  sourceAgentId: z.string().uuid().optional().nullable(),
  sourceBlueprintId: z.string().uuid().optional().nullable(),
});

export type CreateAgentBlueprint = z.infer<typeof createAgentBlueprintSchema>;

export const updateAgentBlueprintSchema = createAgentBlueprintSchema
  .omit({ sourceAgentId: true, sourceBlueprintId: true })
  .partial();

export type UpdateAgentBlueprint = z.infer<typeof updateAgentBlueprintSchema>;
