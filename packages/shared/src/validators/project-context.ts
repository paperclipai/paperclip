import { z } from "zod";

export const contextSourceTypeSchema = z.enum(["manual", "upload", "google_drive", "plugin"]);
export const contextSourceStatusSchema = z.enum(["ready", "syncing", "error", "disabled"]);
export const contextSourceItemStatusSchema = z.enum(["ready", "unsupported", "error"]);

export const projectContextProfileUpdateSchema = z.object({
  goalMarkdown: z.string().max(20_000).optional(),
  instructionsMarkdown: z.string().max(100_000).optional(),
  defaultSkillKeys: z.array(z.string().min(1)).max(100).optional(),
  retrievalEnabled: z.boolean().optional(),
  maxBundleChars: z.number().int().min(1_000).max(100_000).optional(),
  maxChunks: z.number().int().min(0).max(50).optional(),
});

export const contextSourceCreateSchema = z.object({
  sourceType: contextSourceTypeSchema,
  title: z.string().trim().min(1).max(300),
  uri: z.string().trim().max(2_000).nullable().optional(),
  provider: z.string().trim().max(120).nullable().optional(),
  externalId: z.string().trim().max(500).nullable().optional(),
  bodyText: z.string().max(1_000_000).nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
});

export const contextSourceSearchSchema = z.object({
  q: z.string().trim().min(1).max(1_000),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export const contextSourceUpsertItemSchema = z.object({
  externalId: z.string().trim().max(500).nullable().optional(),
  title: z.string().trim().min(1).max(500),
  uri: z.string().trim().max(2_000).nullable().optional(),
  mimeType: z.string().trim().max(200).nullable().optional(),
  bodyText: z.string().max(2_000_000).nullable().optional(),
  status: contextSourceItemStatusSchema.optional(),
  statusMessage: z.string().max(2_000).nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
  sourceModifiedAt: z.string().datetime().nullable().optional(),
});

export type ProjectContextProfileUpdate = z.infer<typeof projectContextProfileUpdateSchema>;
export type ContextSourceCreate = z.infer<typeof contextSourceCreateSchema>;
export type ContextSourceUpsertItem = z.infer<typeof contextSourceUpsertItemSchema>;
