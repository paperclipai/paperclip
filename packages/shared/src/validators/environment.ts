import { z } from "zod";
import {
  ENVIRONMENT_DRIVERS,
  ENVIRONMENT_LEASE_CLEANUP_STATUSES,
  ENVIRONMENT_LEASE_STATUSES,
  ENVIRONMENT_STATUSES,
} from "../constants.js";

export const environmentDriverSchema = z.enum(ENVIRONMENT_DRIVERS);
export const environmentStatusSchema = z.enum(ENVIRONMENT_STATUSES);
export const environmentLeaseStatusSchema = z.enum(ENVIRONMENT_LEASE_STATUSES);
export const environmentLeaseCleanupStatusSchema = z.enum(ENVIRONMENT_LEASE_CLEANUP_STATUSES);

const environmentFields = {
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  driver: environmentDriverSchema,
  status: environmentStatusSchema.optional().default("active"),
  config: z.record(z.unknown()).optional().default({}),
  metadata: z.record(z.unknown()).optional().nullable(),
};

export const createEnvironmentSchema = z.object(environmentFields).strict();
export type CreateEnvironment = z.infer<typeof createEnvironmentSchema>;

export const updateEnvironmentSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  driver: environmentDriverSchema.optional(),
  status: environmentStatusSchema.optional(),
  config: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional().nullable(),
}).strict();
export type UpdateEnvironment = z.infer<typeof updateEnvironmentSchema>;
