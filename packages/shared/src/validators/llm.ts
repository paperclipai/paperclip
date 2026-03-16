import { z } from "zod";

export const llmProviderTypeSchema = z.enum([
  "openrouter",
  "anthropic",
  "openai",
  "huggingface",
  "ollama",
  "custom",
]);

export const createUserLlmCredentialSchema = z.object({
  providerType: llmProviderTypeSchema,
  apiKey: z.string().min(1, "API key required"),
  baseUrl: z.string().url().optional(),
});

export const updateUserLlmCredentialSchema = z.object({
  apiKey: z.string().min(1, "API key required").optional(),
  baseUrl: z.string().url().optional(),
});

export const setCompanyLlmSettingsSchema = z.object({
  preferredProviderType: llmProviderTypeSchema,
  preferredModelId: z.string().min(1, "Model ID required"),
});

export const validateLlmCredentialSchema = z.object({
  providerType: llmProviderTypeSchema,
  apiKey: z.string().min(1),
  baseUrl: z.string().url().optional(),
});

export type LlmProviderType = z.infer<typeof llmProviderTypeSchema>;
export type CreateUserLlmCredential = z.infer<typeof createUserLlmCredentialSchema>;
export type UpdateUserLlmCredential = z.infer<typeof updateUserLlmCredentialSchema>;
export type SetCompanyLlmSettings = z.infer<typeof setCompanyLlmSettingsSchema>;
export type ValidateLlmCredential = z.infer<typeof validateLlmCredentialSchema>;
