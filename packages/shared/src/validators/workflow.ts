import { z } from "zod";
import { WORKFLOW_STATUSES, WORKFLOW_TRIGGER_SOURCES } from "../constants.js";

export const createWorkflowSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lowercase alphanumeric with hyphens"),
  name: z.string().trim().min(1).max(200),
  description: z.string().optional().nullable(),
  definitionYaml: z.string().min(1),
  assigneeAgentId: z.string().uuid().optional().nullable(),
  status: z.enum(WORKFLOW_STATUSES).optional().default("draft"),
  metadata: z.record(z.unknown()).optional().nullable(),
});

export type CreateWorkflow = z.infer<typeof createWorkflowSchema>;

export const updateWorkflowSchema = createWorkflowSchema.partial();
export type UpdateWorkflow = z.infer<typeof updateWorkflowSchema>;

export const assignWorkflowSchema = z.object({
  agentId: z.string().uuid(),
});

export type AssignWorkflow = z.infer<typeof assignWorkflowSchema>;

export const createWorkflowRunSchema = z.object({
  workflowId: z.string().uuid(),
  agentId: z.string().uuid().optional(),
  linkedIssueId: z.string().uuid().optional().nullable(),
  triggerSource: z.enum(WORKFLOW_TRIGGER_SOURCES).optional().default("api"),
  initialStateJson: z.record(z.unknown()).optional().nullable(),
});

export type CreateWorkflowRun = z.infer<typeof createWorkflowRunSchema>;

export const submitWorkflowStepSchema = z.object({
  submissionJson: z.record(z.unknown()),
  notes: z.string().optional().nullable(),
});

export type SubmitWorkflowStep = z.infer<typeof submitWorkflowStepSchema>;
