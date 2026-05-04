import { z } from "zod";
import { BUILDER_PROVIDER_TYPES } from "../types/builder.js";

export const builderProviderTypeSchema = z.enum(BUILDER_PROVIDER_TYPES);

export const createBuilderSessionSchema = z
  .object({
    title: z.string().trim().max(200).optional(),
  })
  .strict();
export type CreateBuilderSession = z.infer<typeof createBuilderSessionSchema>;

export const sendBuilderMessageSchema = z
  .object({
    text: z.string().trim().min(1).max(20_000),
  })
  .strict();
export type SendBuilderMessage = z.infer<typeof sendBuilderMessageSchema>;

export const updateBuilderProviderSettingsSchema = z
  .object({
    providerType: builderProviderTypeSchema,
    model: z.string().trim().min(1).max(200),
    baseUrl: z.string().trim().url().max(500).nullable().optional(),
    secretId: z.string().uuid().nullable().optional(),
    extras: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type UpdateBuilderProviderSettings = z.infer<typeof updateBuilderProviderSettingsSchema>;

export const applyBuilderProposalSchema = z
  .object({
    decisionNote: z.string().trim().max(2000).optional(),
  })
  .strict();
export type ApplyBuilderProposal = z.infer<typeof applyBuilderProposalSchema>;

export const rejectBuilderProposalSchema = applyBuilderProposalSchema;
export type RejectBuilderProposal = z.infer<typeof rejectBuilderProposalSchema>;
