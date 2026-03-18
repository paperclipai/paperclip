import { z } from "zod";
import { CREDENTIAL_TYPES } from "../constants.js";

export const createProviderCredentialSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(CREDENTIAL_TYPES),
  credential: z.record(z.unknown()),
  isDefault: z.boolean().optional().default(false),
});

export type CreateProviderCredential = z.infer<typeof createProviderCredentialSchema>;

export const updateProviderCredentialSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  credential: z.record(z.unknown()).optional(),
  isDefault: z.boolean().optional(),
});

export type UpdateProviderCredential = z.infer<typeof updateProviderCredentialSchema>;
