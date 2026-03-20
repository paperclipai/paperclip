import { z } from "zod";
import {
  AGENT_HOOK_ACTION_TYPES,
  AGENT_HOOK_EVENT_TYPES,
  ISSUE_STATUSES,
} from "../constants.js";

const hookMatchScalarSchema = z.union([z.string(), z.number(), z.boolean()]);
const hookMatchValueSchema = z.union([
  hookMatchScalarSchema,
  z.array(hookMatchScalarSchema).min(1),
]);

const hookCommandActionSchema = z.object({
  type: z.literal(AGENT_HOOK_ACTION_TYPES[0]),
  command: z.string().trim().min(1),
  args: z.array(z.string()).optional().default([]),
  cwd: z.string().trim().min(1).optional().nullable(),
  env: z.record(z.string()).optional().default({}),
  timeoutSec: z.number().int().positive().optional().default(60),
});

const hookWebhookActionSchema = z.object({
  type: z.literal(AGENT_HOOK_ACTION_TYPES[1]),
  url: z.string().trim().min(1),
  method: z.string().trim().min(1).optional().default("POST"),
  headers: z.record(z.string()).optional().default({}),
  body: z.record(z.unknown()).optional().default({}),
  timeoutMs: z.number().int().positive().optional().default(10000),
});

const hookWakeAgentActionSchema = z.object({
  type: z.literal(AGENT_HOOK_ACTION_TYPES[2]),
  agentRefs: z.array(z.string().trim().min(1)).min(1),
  reason: z.string().trim().min(1).optional().nullable(),
  payload: z.record(z.unknown()).optional().nullable().default(null),
  contextSnapshot: z.record(z.unknown()).optional().nullable().default(null),
  forceFreshSession: z.boolean().optional().default(false),
});

const hookAssignIssueActionSchema = z.object({
  type: z.literal(AGENT_HOOK_ACTION_TYPES[3]),
  agentRef: z.string().trim().min(1),
  issueId: z.string().trim().min(1).optional().nullable(),
  status: z.enum(ISSUE_STATUSES).optional().nullable(),
  wakeAssignee: z.boolean().optional().default(false),
});

export const agentHooksPermissionsSchema = z.object({
  allowCommand: z.boolean().optional().default(false),
  allowWebhook: z.boolean().optional().default(false),
  allowIssueAssignment: z.boolean().optional().default(false),
  allowedAgentRefs: z.array(z.string().trim().min(1)).optional().default([]),
});

export const agentHookActionSchema = z.discriminatedUnion("type", [
  hookCommandActionSchema,
  hookWebhookActionSchema,
  hookWakeAgentActionSchema,
  hookAssignIssueActionSchema,
]);

const hookEventSchema = z.enum(AGENT_HOOK_EVENT_TYPES);

export const agentHookRuleSchema = z.object({
  id: z.string().trim().min(1),
  description: z.string().trim().min(1).optional().nullable(),
  enabled: z.boolean().optional().default(true),
  event: z.union([hookEventSchema, z.array(hookEventSchema).min(1)]),
  match: z.record(hookMatchValueSchema).optional(),
  actions: z.array(agentHookActionSchema).min(1),
});

export const agentHooksConfigSchema = z.object({
  enabled: z.boolean().optional().default(true),
  permissions: agentHooksPermissionsSchema.optional().default({}),
  rules: z.array(agentHookRuleSchema).optional().default([]),
});

export type AgentHooksPermissions = z.infer<typeof agentHooksPermissionsSchema>;
export type AgentHookAction = z.infer<typeof agentHookActionSchema>;
export type AgentHookRule = z.infer<typeof agentHookRuleSchema>;
export type AgentHooksConfig = z.infer<typeof agentHooksConfigSchema>;