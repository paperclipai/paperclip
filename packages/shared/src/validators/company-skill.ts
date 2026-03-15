import { z } from "zod";

export const companySkillSourceTypeSchema = z.enum(["local_path", "github", "url", "catalog"]);
export const companySkillTrustLevelSchema = z.enum(["markdown_only", "assets", "scripts_executables"]);
export const companySkillCompatibilitySchema = z.enum(["compatible", "unknown", "invalid"]);
export const companySkillSourceBadgeSchema = z.enum(["paperclip", "github", "local", "url", "catalog"]);

export const companySkillFileInventoryEntrySchema = z.object({
  path: z.string().min(1),
  kind: z.enum(["skill", "markdown", "reference", "script", "asset", "other"]),
});

export const companySkillSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  markdown: z.string(),
  sourceType: companySkillSourceTypeSchema,
  sourceLocator: z.string().nullable(),
  sourceRef: z.string().nullable(),
  trustLevel: companySkillTrustLevelSchema,
  compatibility: companySkillCompatibilitySchema,
  fileInventory: z.array(companySkillFileInventoryEntrySchema).default([]),
  metadata: z.record(z.unknown()).nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const companySkillListItemSchema = companySkillSchema.extend({
  attachedAgentCount: z.number().int().nonnegative(),
  editable: z.boolean(),
  editableReason: z.string().nullable(),
  sourceLabel: z.string().nullable(),
  sourceBadge: companySkillSourceBadgeSchema,
});

export const companySkillUsageAgentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  urlKey: z.string().min(1),
  adapterType: z.string().min(1),
  desired: z.boolean(),
  actualState: z.string().nullable(),
});

export const companySkillDetailSchema = companySkillSchema.extend({
  attachedAgentCount: z.number().int().nonnegative(),
  usedByAgents: z.array(companySkillUsageAgentSchema).default([]),
  editable: z.boolean(),
  editableReason: z.string().nullable(),
  sourceLabel: z.string().nullable(),
  sourceBadge: companySkillSourceBadgeSchema,
});

export const companySkillUpdateStatusSchema = z.object({
  supported: z.boolean(),
  reason: z.string().nullable(),
  trackingRef: z.string().nullable(),
  currentRef: z.string().nullable(),
  latestRef: z.string().nullable(),
  hasUpdate: z.boolean(),
});

export const companySkillImportSchema = z.object({
  source: z.string().min(1),
});

export const companySkillCreateSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).nullable().optional(),
  description: z.string().nullable().optional(),
  markdown: z.string().nullable().optional(),
});

export const companySkillFileDetailSchema = z.object({
  skillId: z.string().uuid(),
  path: z.string().min(1),
  kind: z.enum(["skill", "markdown", "reference", "script", "asset", "other"]),
  content: z.string(),
  language: z.string().nullable(),
  markdown: z.boolean(),
  editable: z.boolean(),
});

export const companySkillFileUpdateSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export type CompanySkillImport = z.infer<typeof companySkillImportSchema>;
export type CompanySkillCreate = z.infer<typeof companySkillCreateSchema>;
export type CompanySkillFileUpdate = z.infer<typeof companySkillFileUpdateSchema>;
