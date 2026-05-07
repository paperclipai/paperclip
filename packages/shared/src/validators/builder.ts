import { z } from "zod";

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
    adapterType: z.string().trim().min(1).max(100),
    adapterConfig: z.record(z.string(), z.unknown()),
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

