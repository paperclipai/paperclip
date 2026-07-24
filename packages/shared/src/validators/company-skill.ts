import { z } from "zod";

export const companySkillSourceTypeSchema = z.enum(["local_path", "github", "url", "catalog", "skills_sh"]);
export const companySkillTrustLevelSchema = z.enum(["markdown_only", "assets", "scripts_executables"]);
export const companySkillCompatibilitySchema = z.enum(["compatible", "unknown", "invalid"]);
export const companySkillSourceBadgeSchema = z.enum(["paperclip", "github", "local", "url", "catalog", "skills_sh"]);
export const companySkillSharingScopeSchema = z.enum(["private", "company", "public_link"]);
export const companySkillListSortSchema = z.enum(["alphabetical", "recent", "installs", "stars", "agents", "forks"]);
export const companySkillListIncludeSchema = z.enum(["lastEditor"]);

export const companySkillFileInventoryEntrySchema = z.object({
  path: z.string().min(1),
  kind: z.enum(["skill", "markdown", "reference", "script", "asset", "other"]),
});

export const companySkillVersionFileInventoryEntrySchema = companySkillFileInventoryEntrySchema.extend({
  content: z.string(),
});

export const companySkillSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  folderId: z.string().uuid().nullable().optional(),
  folderPath: z.string().nullable().optional(),
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
  iconUrl: z.string().nullable(),
  color: z.string().nullable(),
  tagline: z.string().nullable(),
  authorName: z.string().nullable(),
  homepageUrl: z.string().nullable(),
  categories: z.array(z.string().min(1)).default([]),
  sharingScope: companySkillSharingScopeSchema,
  publicShareToken: z.string().nullable(),
  forkedFromSkillId: z.string().uuid().nullable(),
  forkedFromCompanyId: z.string().uuid().nullable(),
  starCount: z.number().int().nonnegative(),
  installCount: z.number().int().nonnegative(),
  forkCount: z.number().int().nonnegative(),
  currentVersionId: z.string().uuid().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const companySkillListItemSchema = companySkillSchema.extend({
  attachedAgentCount: z.number().int().nonnegative(),
  editable: z.boolean(),
  editableReason: z.string().nullable(),
  sourceLabel: z.string().nullable(),
  sourceBadge: companySkillSourceBadgeSchema,
  catalogKind: z.enum(["bundled", "optional"]).nullable(),
  originHash: z.string().nullable(),
  packageName: z.string().nullable(),
  packageVersion: z.string().nullable(),
  lastEditor: z.object({
    kind: z.enum(["user", "agent"]),
    id: z.string().min(1),
    name: z.string().nullable(),
    imageUrl: z.string().nullable(),
  }).nullable().optional(),
});

export const companySkillUsageAgentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  urlKey: z.string().min(1),
  adapterType: z.string().min(1),
  desired: z.boolean(),
  actualState: z.string().nullable().describe(
    "Runtime adapter skill state when explicitly fetched; company skill detail reads return null without probing agent runtimes.",
  ),
  versionId: z.string().uuid().nullable(),
});

export const companySkillOriginalSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  slug: z.string().min(1),
  sourceType: companySkillSourceTypeSchema,
  sourceLocator: z.string().nullable(),
  sourceRef: z.string().nullable(),
});

export const companySkillForkSummarySchema = companySkillOriginalSummarySchema.extend({
  key: z.string().min(1),
  forkedFromSkillId: z.string().uuid().nullable(),
  forkedFromCompanyId: z.string().uuid().nullable(),
  currentVersionId: z.string().uuid().nullable(),
  createdByCurrentActor: z.boolean(),
  diverged: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const companySkillListQuerySchema = z.object({
  q: z.string().min(1).optional(),
  sort: companySkillListSortSchema.optional(),
  categories: z.array(z.string().min(1)).optional(),
  scope: companySkillSharingScopeSchema.optional(),
  include: z.array(companySkillListIncludeSchema).optional(),
  folderId: z.string().uuid().optional(),
  includeSubtree: z.boolean().optional(),
});

export const companySkillCategoryCountSchema = z.object({
  slug: z.string().min(1),
  count: z.number().int().nonnegative(),
});

export const companySkillVersionSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  companySkillId: z.string().uuid(),
  revisionNumber: z.number().int().positive(),
  label: z.string().nullable(),
  fileInventory: z.array(companySkillVersionFileInventoryEntrySchema).default([]),
  authorAgentId: z.string().uuid().nullable(),
  authorUserId: z.string().nullable(),
  createdAt: z.coerce.date(),
});

export const companySkillDetailSchema = companySkillSchema.extend({
  attachedAgentCount: z.number().int().nonnegative(),
  usedByAgents: z.array(companySkillUsageAgentSchema).default([]),
  existingForks: z.array(companySkillForkSummarySchema).default([]),
  editable: z.boolean(),
  editableReason: z.string().nullable(),
  sourceLabel: z.string().nullable(),
  sourceBadge: companySkillSourceBadgeSchema,
  currentVersion: companySkillVersionSchema.nullable(),
  starredByCurrentActor: z.boolean(),
});

export const companySkillVersionCreateSchema = z.object({
  label: z.string().trim().min(1).nullable().optional(),
}).default({});

export const companySkillStarResultSchema = z.object({
  skillId: z.string().uuid(),
  starred: z.boolean(),
  starCount: z.number().int().nonnegative(),
});

export const companySkillCommentSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  companySkillId: z.string().uuid(),
  parentCommentId: z.string().uuid().nullable(),
  authorAgentId: z.string().uuid().nullable(),
  authorUserId: z.string().nullable(),
  body: z.string(),
  deletedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const companySkillCommentCreateSchema = z.object({
  body: z.string().min(1),
  parentCommentId: z.string().uuid().nullable().optional(),
});

export const companySkillCommentUpdateSchema = z.object({
  body: z.string().min(1),
});

export const companySkillForkSchema = z.object({
  name: z.string().min(1).nullable().optional(),
  slug: z.string().min(1).nullable().optional(),
  sharingScope: companySkillSharingScopeSchema.optional(),
  reassignAgentIds: z.array(z.string().uuid()).optional(),
}).default({});

export const companySkillForkReassignmentSchema = z.object({
  agentId: z.string().uuid(),
  previousSkillKey: z.string().min(1),
  nextSkillKey: z.string().min(1),
});

export const companySkillForkResultSchema = z.object({
  skill: companySkillSchema,
  original: companySkillOriginalSummarySchema,
  reassignments: z.array(companySkillForkReassignmentSchema),
});

export const companySkillForkPrecheckResultSchema = z.object({
  skillId: z.string().uuid(),
  original: companySkillOriginalSummarySchema,
  agentUsageCount: z.number().int().nonnegative(),
  usedByAgents: z.array(companySkillUsageAgentSchema),
  existingForks: z.array(companySkillForkSummarySchema),
});

export const companySkillUpdateSchema = z.object({
  description: z.string().nullable().optional(),
  iconUrl: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  tagline: z.string().max(120).nullable().optional(),
  authorName: z.string().nullable().optional(),
  homepageUrl: z.string().nullable().optional(),
  categories: z.array(z.string().min(1)).optional(),
  sharingScope: companySkillSharingScopeSchema.optional(),
}).default({});

export const companySkillUpdateStatusSchema = z.object({
  supported: z.boolean(),
  reason: z.string().nullable(),
  trackingRef: z.string().nullable(),
  currentRef: z.string().nullable(),
  latestRef: z.string().nullable(),
  hasUpdate: z.boolean(),
  installedHash: z.string().nullable(),
  originHash: z.string().nullable(),
  userModifiedAt: z.string().nullable(),
  updateHoldReason: z.enum([
    "local_modifications",
    "audit_hard_stop",
    "origin_unavailable",
    "compatibility_invalid",
    "operator_hold",
  ]).nullable(),
  auditVerdict: z.enum(["pass", "warning", "fail"]).nullable(),
  auditCodes: z.array(z.string()),
});

export const companySkillAuditFindingSchema = z.object({
  code: z.string().min(1),
  severity: z.enum(["warning", "error"]),
  message: z.string().min(1),
  path: z.string().nullable(),
});

export const companySkillAuditResultSchema = z.object({
  skillId: z.string().uuid(),
  installedHash: z.string().nullable(),
  originHash: z.string().nullable(),
  verdict: z.enum(["pass", "warning", "fail"]),
  codes: z.array(z.string()),
  findings: z.array(companySkillAuditFindingSchema),
  scannedAt: z.string().min(1),
  scanVersion: z.string().min(1),
});

export const companySkillInstallUpdateSchema = z.object({
  force: z.boolean().optional(),
}).default({});

export const companySkillResetSchema = z.object({
  force: z.boolean().optional(),
}).default({});

export const companySkillImportSchema = z.object({
  source: z.string().min(1),
});

export const companySkillProjectScanRequestSchema = z.object({
  projectIds: z.array(z.string().uuid()).optional(),
  workspaceIds: z.array(z.string().uuid()).optional(),
  mode: z.enum(["import", "preview"]).optional(),
  selection: z.array(z.object({
    workspaceId: z.string().uuid(),
    path: z.string().min(1),
    slug: z.string().min(1).optional(),
  })).optional(),
});

export const companySkillProjectScanCandidateSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  workspaceId: z.string().uuid(),
  workspaceName: z.string().min(1),
  projectId: z.string().uuid(),
  projectName: z.string().min(1),
  directoryRoot: z.string().min(1),
  relativePath: z.string().min(1),
  status: z.enum(["new", "already_imported", "conflict", "skipped"]),
  existingSkillId: z.string().uuid().optional(),
  reason: z.string().min(1).optional(),
});

export const companySkillProjectScanSkippedSchema = z.object({
  projectId: z.string().uuid().nullable(),
  projectName: z.string().min(1).nullable(),
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
  candidates: z.array(companySkillProjectScanCandidateSchema),
  warnings: z.array(z.string()),
});

export const companySkillCreateSchema = z.object({
  folderId: z.string().uuid().nullable().optional(),
  name: z.string().min(1),
  slug: z.string().min(1).nullable().optional(),
  description: z.string().nullable().optional(),
  markdown: z.string().nullable().optional(),
  iconUrl: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  tagline: z.string().max(120).nullable().optional(),
  authorName: z.string().nullable().optional(),
  homepageUrl: z.string().nullable().optional(),
  categories: z.array(z.string().min(1)).optional(),
  sharingScope: companySkillSharingScopeSchema.optional(),
  forkedFromSkillId: z.string().uuid().nullable().optional(),
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

export const companySkillFileDeleteSchema = z.object({
  path: z.string().min(1),
  target: z.enum(["file", "folder"]),
});

export const companySkillTestRunStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);

export const companySkillTestInputSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  skillId: z.string().uuid(),
  name: z.string().min(1),
  content: z.string(),
  createdBy: z.string().nullable(),
  deletedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const companySkillTestInputCreateSchema = z.object({
  name: z.string().trim().min(1),
  content: z.string().min(1),
});

export const companySkillTestInputUpdateSchema = z.object({
  name: z.string().trim().min(1).optional(),
  content: z.string().min(1).optional(),
}).refine((value) => value.name !== undefined || value.content !== undefined, {
  message: "At least one field is required",
});

export const companySkillTestRunTemplateSchema = z.object({
  id: z.string().min(1),
  companyId: z.string().uuid(),
  name: z.string().min(1),
  description: z.string().nullable(),
  body: z.string().min(1),
  builtIn: z.boolean(),
  createdByAgentId: z.string().uuid().nullable(),
  createdByUserId: z.string().nullable(),
  updatedByAgentId: z.string().uuid().nullable(),
  updatedByUserId: z.string().nullable(),
  deletedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const companySkillTestRunTemplateCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  body: z.string().min(1).max(20_000),
});

export const companySkillTestRunTemplateUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  body: z.string().min(1).max(20_000).optional(),
}).refine(
  (value) => value.name !== undefined || value.description !== undefined || value.body !== undefined,
  { message: "At least one field is required" },
);

export const companySkillTestRunTemplateSnapshotSchema = z.object({
  templateId: z.string().min(1).nullable(),
  templateName: z.string().min(1).nullable(),
  templateBody: z.string().min(1).max(20_000).nullable(),
}).refine(
  (value) =>
    (value.templateId === null && value.templateName === null && value.templateBody === null)
    || (value.templateId !== null && value.templateName !== null && value.templateBody !== null),
  { message: "Template snapshot must be all null or include id, name, and body" },
);

export const companySkillTestRunCostSummarySchema = z.object({
  costCents: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});

export const companySkillTestRunSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  skillId: z.string().uuid(),
  inputId: z.string().uuid().nullable(),
  inputSnapshot: z.string(),
  skillVersionId: z.string().uuid(),
  agentId: z.string().uuid(),
  agentConfigSnapshot: z.record(z.string(), z.unknown()),
  issueId: z.string().uuid(),
  templateId: z.string().nullable(),
  templateName: z.string().nullable(),
  templateBody: z.string().nullable(),
  renderedTemplateBody: z.string().nullable(),
  harnessIssueDescription: z.string(),
  status: companySkillTestRunStatusSchema,
  outputDocumentKey: z.string().min(1),
  outputSnapshot: z.string(),
  error: z.string().nullable(),
  deletedAt: z.coerce.date().nullable(),
  supersededAt: z.coerce.date().nullable(),
  harnessIssueExpiresAt: z.coerce.date().nullable(),
  harnessIssueDeletedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  cost: companySkillTestRunCostSummarySchema,
  taskExpired: z.boolean(),
});

export const companySkillTestRunCreateSchema = z.object({
  inputId: z.string().uuid().nullable().optional(),
  content: z.string().min(1).nullable().optional(),
  agentId: z.string().uuid(),
  templateId: z.string().min(1).nullable().optional(),
  templateSnapshot: companySkillTestRunTemplateSnapshotSchema.nullable().optional(),
  // Re-run pins the viewed run's skill version instead of the live head, so the
  // new run reproduces the same snapshots (golden-path step 5).
  skillVersionId: z.string().uuid().nullable().optional(),
}).refine((value) => Boolean(value.inputId) || Boolean(value.content?.trim()), {
  message: "inputId or content is required",
});

export const companySkillTestRunListQuerySchema = z.object({
  inputId: z.string().uuid().optional(),
});

export const catalogSkillKindSchema = z.enum(["bundled", "optional"]);

export const catalogSkillFileSchema = z.object({
  path: z.string().min(1),
  kind: z.enum(["skill", "markdown", "reference", "script", "asset", "other"]),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().min(1),
});

export const catalogSkillGitHubSourceSchema = z.object({
  type: z.literal("github"),
  hostname: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
  ref: z.string().min(1),
  commit: z.string().regex(/^[0-9a-f]{40}$/i),
  path: z.string(),
  url: z.string().url(),
});

export const catalogSkillSourceSchema = catalogSkillGitHubSourceSchema;

export const catalogSkillSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  kind: catalogSkillKindSchema,
  category: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  path: z.string().min(1),
  entrypoint: z.literal("SKILL.md"),
  trustLevel: companySkillTrustLevelSchema,
  compatibility: companySkillCompatibilitySchema,
  defaultInstall: z.boolean(),
  recommendedForRoles: z.array(z.string()),
  requires: z.array(z.string()),
  tags: z.array(z.string()),
  files: z.array(catalogSkillFileSchema),
  contentHash: z.string().min(1),
  source: catalogSkillSourceSchema.optional(),
  packageName: z.string().min(1).optional(),
  packageVersion: z.string().min(1).optional(),
});

export const catalogSkillListQuerySchema = z.object({
  kind: catalogSkillKindSchema.optional(),
  category: z.string().min(1).optional(),
  q: z.string().min(1).optional(),
});

export const catalogSkillFileDetailSchema = z.object({
  catalogSkillId: z.string().min(1),
  path: z.string().min(1),
  kind: z.enum(["skill", "markdown", "reference", "script", "asset", "other"]),
  content: z.string(),
  language: z.string().nullable(),
  markdown: z.boolean(),
});

export const companySkillInstallCatalogSchema = z.object({
  catalogSkillId: z.string().min(1),
  slug: z.string().min(1).nullable().optional(),
  force: z.boolean().optional(),
});

export const companySkillInstallCatalogResultSchema = z.object({
  action: z.enum(["created", "updated", "unchanged"]),
  skill: companySkillSchema,
  catalogSkill: catalogSkillSchema,
  warnings: z.array(z.string()),
});

export type CompanySkillImport = z.infer<typeof companySkillImportSchema>;
export type CompanySkillListQuery = z.infer<typeof companySkillListQuerySchema>;
export type CompanySkillProjectScan = z.infer<typeof companySkillProjectScanRequestSchema>;
export type CompanySkillCreate = z.infer<typeof companySkillCreateSchema>;
export type CompanySkillFileUpdate = z.infer<typeof companySkillFileUpdateSchema>;
export type CompanySkillFileDelete = z.infer<typeof companySkillFileDeleteSchema>;
export type CompanySkillTestInputCreate = z.infer<typeof companySkillTestInputCreateSchema>;
export type CompanySkillTestInputUpdate = z.infer<typeof companySkillTestInputUpdateSchema>;
export type CompanySkillTestRunTemplateCreate = z.infer<typeof companySkillTestRunTemplateCreateSchema>;
export type CompanySkillTestRunTemplateUpdate = z.infer<typeof companySkillTestRunTemplateUpdateSchema>;
export type CompanySkillTestRunCreate = z.infer<typeof companySkillTestRunCreateSchema>;
export type CompanySkillTestRunListQuery = z.infer<typeof companySkillTestRunListQuerySchema>;
export type CompanySkillVersionCreate = z.infer<typeof companySkillVersionCreateSchema>;
export type CompanySkillCommentCreate = z.infer<typeof companySkillCommentCreateSchema>;
export type CompanySkillCommentUpdate = z.infer<typeof companySkillCommentUpdateSchema>;
export type CompanySkillFork = z.infer<typeof companySkillForkSchema>;
export type CompanySkillUpdate = z.infer<typeof companySkillUpdateSchema>;
export type CatalogSkillListQuery = z.infer<typeof catalogSkillListQuerySchema>;
export type CompanySkillInstallCatalog = z.infer<typeof companySkillInstallCatalogSchema>;
export type CompanySkillInstallUpdate = z.infer<typeof companySkillInstallUpdateSchema>;
export type CompanySkillReset = z.infer<typeof companySkillResetSchema>;
