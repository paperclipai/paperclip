import { z } from "zod";

export const rt2TaskModeSchema = z.enum(["solo", "collab"]);
export const rt2ParticipantStateSchema = z.enum(["active", "ended"]);
export const rt2ParticipantEndReasonSchema = z.enum(["manager_removed", "self_left", "capacity_reduced"]);
export const rt2DeliverableKindSchema = z.enum(["document", "artifact"]);
export const rt2DeliverableStateSchema = z.enum(["defined", "submitted"]);

export const rt2DeliverableInputSchema = z.object({
  title: z.string().trim().min(1),
  type: rt2DeliverableKindSchema,
  summary: z.string().trim().min(1).nullable().optional(),
});

export const createRt2TaskSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().trim().min(1),
  goalId: z.string().uuid().nullable().optional(),
  description: z.string().trim().min(1).nullable().optional(),
  priority: z.enum(["critical", "high", "medium", "low"]).default("medium"),
  taskMode: rt2TaskModeSchema,
  capacity: z.number().int().min(1),
  deliverables: z.array(rt2DeliverableInputSchema).min(1),
});

export type CreateRt2Task = z.infer<typeof createRt2TaskSchema>;

export const createRt2TodoSchema = z.object({
  taskIssueId: z.string().uuid(),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1).nullable().optional(),
  assigneeUserId: z.string().trim().min(1),
  deliverables: z.array(rt2DeliverableInputSchema).min(1),
});

export type CreateRt2Todo = z.infer<typeof createRt2TodoSchema>;

export const updateRt2TaskCapacitySchema = z.object({
  capacity: z.number().int().min(1),
  endedUserIds: z.array(z.string().trim().min(1)).default([]),
});

export type UpdateRt2TaskCapacity = z.infer<typeof updateRt2TaskCapacitySchema>;

export const endRt2ParticipantSchema = z.object({
  reason: rt2ParticipantEndReasonSchema,
});

export type EndRt2Participant = z.infer<typeof endRt2ParticipantSchema>;
