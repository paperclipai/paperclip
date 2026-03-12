import { z } from "zod";
import { NODE_STATUSES } from "../constants.js";

export const createNodeSchema = z.object({
  name: z.string().min(1),
  capabilities: z.record(z.unknown()).optional().default({}),
  metadata: z.record(z.unknown()).optional().default({}),
});

export type CreateNode = z.infer<typeof createNodeSchema>;

export const updateNodeSchema = z.object({
  name: z.string().min(1).optional(),
  status: z.enum(NODE_STATUSES).optional(),
  capabilities: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type UpdateNode = z.infer<typeof updateNodeSchema>;

export const createNodeKeySchema = z.object({
  name: z.string().min(1).default("default"),
});

export type CreateNodeKey = z.infer<typeof createNodeKeySchema>;
