import { z } from "zod";

export const memoryPlaneEventEntityTypeSchema = z.enum(["routine", "goal", "routine_run"]);

export const memoryPlaneLifecycleEventSchema = z.object({
  id: z.string().uuid(),
  entityType: memoryPlaneEventEntityTypeSchema,
  entityId: z.string().uuid(),
  companyId: z.string().uuid(),
  oldStatus: z.string().nullable(),
  newStatus: z.string().min(1),
  timestamp: z.string().datetime(),
  agentId: z.string().uuid().nullable(),
  actorType: z.string().min(1),
  actorId: z.string().nullable(),
  runId: z.string().uuid().nullable(),
  metadata: z.record(z.unknown()).default({}),
});

export type MemoryPlaneLifecycleEventInput = z.infer<typeof memoryPlaneLifecycleEventSchema>;

export const ob1InstanceConfigSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  apiKey: z.string().nullable().optional(),
});