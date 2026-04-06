import { z } from "zod";
import {
  DELIVERABLE_TYPES,
  DELIVERABLE_STATUSES,
  DELIVERABLE_PRIORITIES,
} from "../constants.js";

export const createDeliverableSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  type: z.enum(DELIVERABLE_TYPES).optional().default("mixed"),
  status: z.enum(DELIVERABLE_STATUSES).optional().default("draft"),
  priority: z.enum(DELIVERABLE_PRIORITIES).optional().nullable(),
  assigneeAgentId: z.string().uuid().optional().nullable(),
  projectId: z.string().uuid().optional().nullable(),
  issueId: z.string().uuid().optional().nullable(),
  dueAt: z.string().datetime().optional().nullable(),
});

export type CreateDeliverable = z.infer<typeof createDeliverableSchema>;

export const updateDeliverableSchema = createDeliverableSchema.partial();

export type UpdateDeliverable = z.infer<typeof updateDeliverableSchema>;

export const addDeliverableCommentSchema = z.object({
  body: z.string().min(1),
});

export type AddDeliverableComment = z.infer<typeof addDeliverableCommentSchema>;
