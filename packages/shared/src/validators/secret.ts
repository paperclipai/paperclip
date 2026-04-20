import { z } from "zod";
import { SECRET_PROVIDERS } from "../constants.js";

export const envBindingPlainSchema = z.object({
  type: z.literal("plain"),
  value: z.string(),
});

export const envBindingSecretRefSchema = z.object({
  type: z.literal("secret_ref"),
  secretId: z.string().uuid(),
  version: z.union([z.literal("latest"), z.number().int().positive()]).optional(),
});

// Backward-compatible union that accepts legacy inline values.
export const envBindingSchema = z.union([z.string(), envBindingPlainSchema, envBindingSecretRefSchema]);

export const envConfigSchema = z.record(envBindingSchema);

export const createSecretSchema = z.object({
  name: z.string().min(1),
  provider: z.enum(SECRET_PROVIDERS).optional(),
  value: z.string().min(1),
  description: z.string().optional().nullable(),
  externalRef: z.string().optional().nullable(),
});

export type CreateSecret = z.infer<typeof createSecretSchema>;

export const rotateSecretSchema = z.object({
  value: z.string().min(1),
  externalRef: z.string().optional().nullable(),
});

export type RotateSecret = z.infer<typeof rotateSecretSchema>;

export const updateSecretSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  externalRef: z.string().optional().nullable(),
});

export type UpdateSecret = z.infer<typeof updateSecretSchema>;
