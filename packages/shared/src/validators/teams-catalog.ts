import { z } from "zod";
import {
  portabilityAdapterOverrideSchema,
  portabilityAgentSelectionSchema,
  portabilityCollisionStrategySchema,
  portabilityIncludeSchema,
} from "./company-portability.js";

export const catalogTeamKindSchema = z.enum(["bundled", "optional"]);

export const catalogTeamTrustLevelSchema = z.enum([
  "markdown_only",
  "assets",
  "scripts_executables",
  "external_sources",
]);

export const catalogTeamCompatibilitySchema = z.enum(["compatible", "unknown", "invalid"]);

export const catalogTeamFileKindSchema = z.enum([
  "team",
  "agent",
  "project",
  "task",
  "skill",
  "extension",
  "readme",
  "reference",
  "script",
  "asset",
  "markdown",
  "other",
]);

export const catalogTeamSkillRequirementTypeSchema = z.enum([
  "catalog",
  "local",
  "skills_sh",
  "github",
  "url",
  "local_path",
  "agent_package",
]);

export const catalogTeamSkillRequirementSchema = z.object({
  type: catalogTeamSkillRequirementTypeSchema,
  ref: z.string().min(1),
  agentSlugs: z.array(z.string().min(1)),
  resolved: z.boolean(),
  catalogSkillId: z.string().min(1).optional(),
  catalogSkillKey: z.string().min(1).optional(),
  localPath: z.string().min(1).optional(),
  sourceLocator: z.string().min(1).optional(),
  sourceRef: z.string().min(1).optional(),
});

export const catalogTeamEnvInputSummarySchema = z.object({
  key: z.string().min(1),
  agentSlug: z.string().min(1).nullable(),
  projectSlug: z.string().min(1).nullable(),
  kind: z.enum(["secret", "plain"]),
  requirement: z.enum(["required", "optional"]),
});

export const catalogTeamSourceRefSchema = z.object({
  type: z.enum(["skills_sh", "github", "url", "local_path", "agent_package", "include"]),
  ref: z.string().min(1),
  pinned: z.boolean(),
});

export const catalogTeamFileSchema = z.object({
  path: z.string().min(1),
  kind: catalogTeamFileKindSchema,
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().min(1),
});

export const catalogTeamSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  kind: catalogTeamKindSchema,
  category: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  path: z.string().min(1),
  entrypoint: z.literal("TEAM.md"),
  schema: z.literal("agentcompanies/v1"),
  defaultInstall: z.boolean(),
  recommendedForCompanyTypes: z.array(z.string()),
  tags: z.array(z.string()),
  counts: z.object({
    agents: z.number().int().nonnegative(),
    projects: z.number().int().nonnegative(),
    tasks: z.number().int().nonnegative(),
    routines: z.number().int().nonnegative(),
    localSkills: z.number().int().nonnegative(),
    catalogSkills: z.number().int().nonnegative(),
    externalSkillSources: z.number().int().nonnegative(),
  }),
  rootAgentSlugs: z.array(z.string()),
  agentSlugs: z.array(z.string()),
  projectSlugs: z.array(z.string()),
  requiredSkills: z.array(catalogTeamSkillRequirementSchema),
  envInputs: z.array(catalogTeamEnvInputSummarySchema),
  sourceRefs: z.array(catalogTeamSourceRefSchema),
  files: z.array(catalogTeamFileSchema),
  trustLevel: catalogTeamTrustLevelSchema,
  compatibility: catalogTeamCompatibilitySchema,
  contentHash: z.string().min(1),
  packageName: z.string().min(1).optional(),
  packageVersion: z.string().min(1).optional(),
});

export const catalogTeamListQuerySchema = z.object({
  kind: catalogTeamKindSchema.optional(),
  category: z.string().min(1).optional(),
  q: z.string().min(1).optional(),
});

export const catalogTeamFileDetailSchema = z.object({
  catalogTeamId: z.string().min(1),
  path: z.string().min(1),
  kind: catalogTeamFileKindSchema,
  content: z.string(),
  language: z.string().nullable(),
  markdown: z.boolean(),
});

export const catalogTeamSourcePolicySchema = z.object({
  allowExternalSources: z.boolean().optional(),
  allowUnpinnedOptionalSources: z.boolean().optional(),
  allowLocalPathSources: z.boolean().optional(),
}).strict();

export const catalogTeamPreviewSchema = z.object({
  targetManagerAgentId: z.string().min(1).nullable().optional(),
  targetManagerSlug: z.string().min(1).nullable().optional(),
  include: portabilityIncludeSchema.omit({ company: true }).strict().optional(),
  agents: portabilityAgentSelectionSchema.optional(),
  collisionStrategy: portabilityCollisionStrategySchema.optional(),
  nameOverrides: z.record(z.string().min(1), z.string().min(1)).optional(),
  selectedFiles: z.array(z.string().min(1)).optional(),
  sourcePolicy: catalogTeamSourcePolicySchema.optional(),
}).strict();

export const catalogTeamInstallSchema = catalogTeamPreviewSchema.extend({
  adapterOverrides: z.record(z.string().min(1), portabilityAdapterOverrideSchema).optional(),
  secretValues: z.record(z.string().min(1), z.string()).optional(),
}).strict();

export const catalogTeamSkillPreparationSchema = z.object({
  type: catalogTeamSkillRequirementTypeSchema,
  ref: z.string().min(1),
  agentSlugs: z.array(z.string().min(1)),
  action: z.enum([
    "already_in_package",
    "catalog_install_required",
    "external_import_required",
    "blocked",
  ]),
  catalogSkillId: z.string().min(1).nullable(),
  catalogSkillKey: z.string().min(1).nullable(),
  sourceLocator: z.string().min(1).nullable(),
  sourceRef: z.string().min(1).nullable(),
  reason: z.string().min(1).nullable(),
});

export type CatalogTeamListQuery = z.infer<typeof catalogTeamListQuerySchema>;
export type CatalogTeamPreview = z.infer<typeof catalogTeamPreviewSchema>;
export type CatalogTeamInstall = z.infer<typeof catalogTeamInstallSchema>;
