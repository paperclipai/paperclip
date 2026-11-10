import { z } from "zod";

export const AGENT_INTERACTION_PERMISSION_KEYS = [
  "canAssignTasksToAgents",
  "canReceiveAssignmentsFromAgents",
  "canAssignTasksToHumans",
  "canMentionAgents",
  "canReceiveMentionsFromAgents",
  "canCommentOnOtherTasks",
  "canReceiveCommentsFromAgents",
  "canEditOtherTasks",
  "canReceiveTaskEditsFromAgents",
  "canConfigureOtherAgents",
  "canReceiveConfigurationChangesFromAgents",
] as const;

export type AgentInteractionPermissionKey = (typeof AGENT_INTERACTION_PERMISSION_KEYS)[number];
export type AgentInteractionPermissions = Partial<Record<AgentInteractionPermissionKey, boolean>>;
export type AgentInteractionPermissionsPatch = Partial<Record<AgentInteractionPermissionKey, boolean | null>>;

const shape = Object.fromEntries(AGENT_INTERACTION_PERMISSION_KEYS.map(key => [key, z.boolean().optional()])) as
  Record<AgentInteractionPermissionKey, z.ZodOptional<z.ZodBoolean>>;
const patchShape = Object.fromEntries(AGENT_INTERACTION_PERMISSION_KEYS.map(key => [key, z.boolean().nullable().optional()])) as
  Record<AgentInteractionPermissionKey, z.ZodOptional<z.ZodNullable<z.ZodBoolean>>>;

export const agentInteractionPermissionsSchema = z.object(shape).strict();
export const updateAgentInteractionPermissionsSchema = z.object(patchShape).strict()
  .refine(value => Object.keys(value).length > 0, "Provide at least one interaction permission");

export function resolveAgentInteractionPermissions(value: unknown): Record<AgentInteractionPermissionKey, boolean> {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return Object.fromEntries(AGENT_INTERACTION_PERMISSION_KEYS.map(key => [key, record[key] !== false])) as
    Record<AgentInteractionPermissionKey, boolean>;
}

export interface AgentInteractionPermissionsState {
  agentId: string;
  companyId: string;
  overrides: AgentInteractionPermissions;
  effective: Record<AgentInteractionPermissionKey, boolean>;
}
