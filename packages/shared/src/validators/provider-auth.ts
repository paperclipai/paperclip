import { z } from "zod";
import {
  AGENT_ADAPTER_TYPES,
  KNOWN_PROVIDER_CREDENTIAL_PROVIDERS,
} from "../constants.js";

export const providerCredentialProviderSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, {
    message:
      "provider must contain only letters, numbers, underscores, or hyphens",
  });

export const providerCredentialEnvKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Z_][A-Z0-9_]*$/, {
    message: "envKey must be an uppercase environment variable name",
  });

export const providerCredentialLabelSchema = z.string().trim().min(1).max(120);

export const providerConnectionLegacySchema = z.object({
  provider: providerCredentialProviderSchema,
  apiKey: z.string().min(1),
  validateOnly: z.boolean().optional().default(false),
  label: providerCredentialLabelSchema.optional(),
  envKey: providerCredentialEnvKeySchema.optional(),
  isDefault: z.boolean().optional().default(true),
});

export type ProviderConnectionLegacyInput = z.infer<
  typeof providerConnectionLegacySchema
>;

export const createProviderCredentialSchema = z.object({
  provider: providerCredentialProviderSchema,
  envKey: providerCredentialEnvKeySchema,
  label: providerCredentialLabelSchema,
  apiKey: z.string().min(1),
  validateOnly: z.boolean().optional().default(false),
  isDefault: z.boolean().optional().default(false),
});

export type CreateProviderCredential = z.infer<
  typeof createProviderCredentialSchema
>;

export const rotateProviderCredentialSchema = z.object({
  apiKey: z.string().min(1),
  validateOnly: z.boolean().optional().default(false),
});

export type RotateProviderCredential = z.infer<
  typeof rotateProviderCredentialSchema
>;

export const updateProviderCredentialSchema = z
  .object({
    label: providerCredentialLabelSchema.optional(),
    isDefault: z.boolean().optional(),
  })
  .refine((value) => value.label !== undefined || value.isDefault !== undefined, {
    message: "Provide label and/or isDefault",
  });

export type UpdateProviderCredential = z.infer<
  typeof updateProviderCredentialSchema
>;

export const adapterAuthStatusRequestSchema = z.object({
  adapterType: z.enum(AGENT_ADAPTER_TYPES),
  adapterConfig: z.record(z.unknown()).optional().default({}),
});

export type AdapterAuthStatusRequest = z.infer<
  typeof adapterAuthStatusRequestSchema
>;

export const knownProviderCredentialProvidersSchema = z.enum(
  KNOWN_PROVIDER_CREDENTIAL_PROVIDERS,
);

export type KnownProviderCredentialProviderInput = z.infer<
  typeof knownProviderCredentialProvidersSchema
>;
