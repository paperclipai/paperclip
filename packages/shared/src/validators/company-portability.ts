import { z } from "zod";
import { GOAL_LEVELS, GOAL_STATUSES, ISSUE_PRIORITIES, ISSUE_STATUSES, PROJECT_STATUSES } from "../constants.js";

export const portabilityIncludeSchema = z
  .object({
    company: z.boolean().optional(),
    agents: z.boolean().optional(),
    goals: z.boolean().optional(),
    projects: z.boolean().optional(),
    issues: z.boolean().optional(),
  })
  .partial();

export const portabilitySecretRequirementSchema = z.object({
  key: z.string().min(1),
  description: z.string().nullable(),
  agentSlug: z.string().min(1).nullable(),
  providerHint: z.string().nullable(),
});

export const portabilityCompanyManifestEntrySchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  brandColor: z.string().nullable(),
  requireBoardApprovalForNewAgents: z.boolean(),
});

export const portabilityAgentManifestEntrySchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  role: z.string().min(1),
  title: z.string().nullable(),
  icon: z.string().nullable(),
  capabilities: z.string().nullable(),
  reportsToSlug: z.string().min(1).nullable(),
  adapterType: z.string().min(1),
  adapterConfig: z.record(z.unknown()),
  runtimeConfig: z.record(z.unknown()),
  permissions: z.record(z.unknown()),
  budgetMonthlyCents: z.number().int().nonnegative(),
  metadata: z.record(z.unknown()).nullable(),
});

export const portabilityGoalManifestEntrySchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  description: z.string().nullable(),
  level: z.enum(GOAL_LEVELS),
  status: z.enum(GOAL_STATUSES),
  parentKey: z.string().min(1).nullable(),
  ownerAgentSlug: z.string().min(1).nullable(),
});

export const portabilityProjectWorkspaceManifestEntrySchema = z.object({
  name: z.string().min(1),
  cwd: z.string().min(1).nullable(),
  repoUrl: z.string().url().nullable(),
  repoRef: z.string().nullable(),
  metadata: z.record(z.unknown()).nullable(),
  isPrimary: z.boolean(),
});

export const portabilityProjectManifestEntrySchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  status: z.enum(PROJECT_STATUSES),
  goalKeys: z.array(z.string().min(1)).default([]),
  leadAgentSlug: z.string().min(1).nullable(),
  targetDate: z.string().nullable(),
  color: z.string().nullable(),
  workspaces: z.array(portabilityProjectWorkspaceManifestEntrySchema).default([]),
});

export const portabilityIssueManifestEntrySchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  description: z.string().nullable(),
  status: z.enum(ISSUE_STATUSES),
  priority: z.enum(ISSUE_PRIORITIES),
  projectKey: z.string().min(1).nullable(),
  goalKey: z.string().min(1).nullable(),
  parentKey: z.string().min(1).nullable(),
  assigneeAgentSlug: z.string().min(1).nullable(),
  requestDepth: z.number().int().nonnegative(),
  billingCode: z.string().nullable(),
});

export const portabilityManifestSchema = z.object({
  schemaVersion: z.number().int().positive(),
  generatedAt: z.string().datetime(),
  source: z
    .object({
      companyId: z.string().uuid(),
      companyName: z.string().min(1),
    })
    .nullable(),
  includes: z.object({
    company: z.boolean(),
    agents: z.boolean(),
    goals: z.boolean().default(false),
    projects: z.boolean().default(false),
    issues: z.boolean().default(false),
  }),
  company: portabilityCompanyManifestEntrySchema.nullable(),
  agents: z.array(portabilityAgentManifestEntrySchema),
  goals: z.array(portabilityGoalManifestEntrySchema).default([]),
  projects: z.array(portabilityProjectManifestEntrySchema).default([]),
  issues: z.array(portabilityIssueManifestEntrySchema).default([]),
  requiredSecrets: z.array(portabilitySecretRequirementSchema).default([]),
});

export const portabilitySourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("inline"),
    manifest: portabilityManifestSchema,
    files: z.record(z.string()),
  }),
  z.object({
    type: z.literal("builtin"),
    templateId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  }),
  z.object({
    type: z.literal("url"),
    url: z.string().url(),
  }),
  z.object({
    type: z.literal("github"),
    url: z.string().url(),
  }),
]);

export const portabilityTargetSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("new_company"),
    newCompanyName: z.string().min(1).optional().nullable(),
  }),
  z.object({
    mode: z.literal("existing_company"),
    companyId: z.string().uuid(),
  }),
]);

export const portabilityAgentSelectionSchema = z.union([
  z.literal("all"),
  z.array(z.string().min(1)),
]);

export const portabilityCollisionStrategySchema = z.enum(["rename", "skip", "replace"]);

export const companyPortabilityExportSchema = z.object({
  include: portabilityIncludeSchema.optional(),
});

export type CompanyPortabilityExport = z.infer<typeof companyPortabilityExportSchema>;

export const companyPortabilityPreviewSchema = z.object({
  source: portabilitySourceSchema,
  include: portabilityIncludeSchema.optional(),
  target: portabilityTargetSchema,
  agents: portabilityAgentSelectionSchema.optional(),
  collisionStrategy: portabilityCollisionStrategySchema.optional(),
});

export type CompanyPortabilityPreview = z.infer<typeof companyPortabilityPreviewSchema>;

export const companyPortabilityImportSchema = companyPortabilityPreviewSchema;

export type CompanyPortabilityImport = z.infer<typeof companyPortabilityImportSchema>;
