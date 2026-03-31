import { z } from "zod";

export const companySkillSourceTypeSchema = z.enum(["local_path", "github", "url", "catalog", "skills_sh"]);
export const companySkillTrustLevelSchema = z.enum(["markdown_only", "assets", "scripts_executables"]);
export const companySkillCompatibilitySchema = z.enum(["compatible", "unknown", "invalid"]);
export const companySkillSourceBadgeSchema = z.enum(["paperclip", "github", "local", "url", "catalog", "skills_sh"]);

export const companySkillFileInventoryEntrySchema = z.object({
  path: z.string().min(1),
  kind: z.enum(["skill", "markdown", "reference", "script", "asset", "other"]),
});

export const companySkillSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  key: z.string().min(1),
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

export const companySkillProjectScanRequestSchema = z.object({
  projectIds: z.array(z.string().uuid()).optional(),
  workspaceIds: z.array(z.string().uuid()).optional(),
});

export const companySkillProjectScanSkippedSchema = z.object({
  projectId: z.string().uuid(),
  projectName: z.string().min(1),
  workspaceId: z.string().uuid().nullable(),
  workspaceName: z.string().nullable(),
  path: z.string().nullable(),
  reason: z.string().min(1),
});

export const companySkillProjectScanConflictSchema = z.object({
  slug: z.string().min(1),
  key: z.string().min(1),
  projectId: z.string().uuid(),
  projectName: z.string().min(1),
  workspaceId: z.string().uuid(),
  workspaceName: z.string().min(1),
  path: z.string().min(1),
  existingSkillId: z.string().uuid(),
  existingSkillKey: z.string().min(1),
  existingSourceLocator: z.string().nullable(),
  reason: z.string().min(1),
});

export const companySkillProjectScanResultSchema = z.object({
  scannedProjects: z.number().int().nonnegative(),
  scannedWorkspaces: z.number().int().nonnegative(),
  discovered: z.number().int().nonnegative(),
  imported: z.array(companySkillSchema),
  updated: z.array(companySkillSchema),
  skipped: z.array(companySkillProjectScanSkippedSchema),
  conflicts: z.array(companySkillProjectScanConflictSchema),
  warnings: z.array(z.string()),
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
export type CompanySkillProjectScan = z.infer<typeof companySkillProjectScanRequestSchema>;
export type CompanySkillCreate = z.infer<typeof companySkillCreateSchema>;
export type CompanySkillFileUpdate = z.infer<typeof companySkillFileUpdateSchema>;
