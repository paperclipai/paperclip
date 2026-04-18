import { z } from "zod";
import { ISSUE_PRIORITIES } from "../constants.js";
import { issueExecutionPolicySchema } from "./issue.js";

const workflowTemplateNodeSchema = z.object({
  tempId: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(500),
  description: z.string().optional().nullable(),
  blockedByTempIds: z.array(z.string().trim().min(1).max(100)).default([]),
  parentTempId: z.string().trim().min(1).max(100).optional().nullable(),
  executionPolicy: issueExecutionPolicySchema.optional().nullable(),
  defaultAssigneeAgentId: z.string().uuid().optional().nullable(),
  defaultPriority: z.enum(ISSUE_PRIORITIES).optional().nullable(),
});

export const createWorkflowTemplateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().optional().nullable(),
  nodes: z.array(workflowTemplateNodeSchema).min(1),
});

export type CreateWorkflowTemplate = z.infer<typeof createWorkflowTemplateSchema>;

export const updateWorkflowTemplateSchema = createWorkflowTemplateSchema.partial();
export type UpdateWorkflowTemplate = z.infer<typeof updateWorkflowTemplateSchema>;

const workflowNodeOverrideSchema = z.object({
  assigneeAgentId: z.string().uuid().optional().nullable(),
  assigneeUserId: z.string().optional().nullable(),
  priority: z.enum(ISSUE_PRIORITIES).optional(),
  projectId: z.string().uuid().optional().nullable(),
  goalId: z.string().uuid().optional().nullable(),
  billingCode: z.string().optional().nullable(),
  executionPolicy: issueExecutionPolicySchema.optional().nullable(),
});

export const workflowInvokeInputSchema = z.object({
  context: z.string().optional().nullable(),
  defaultAssigneeAgentId: z.string().uuid().optional().nullable(),
  nodeOverrides: z.record(z.string(), workflowNodeOverrideSchema).optional().nullable(),
  goalId: z.string().uuid().optional().nullable(),
  projectId: z.string().uuid().optional().nullable(),
});

export type WorkflowInvokeInput = z.infer<typeof workflowInvokeInputSchema>;
