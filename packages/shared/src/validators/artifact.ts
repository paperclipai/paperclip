import { z } from "zod";

export const COMPANY_ARTIFACTS_DEFAULT_LIMIT = 30;
export const COMPANY_ARTIFACTS_MAX_LIMIT = 100;
export const COMPANY_ARTIFACTS_MAX_QUERY_LENGTH = 160;

export const companyArtifactSourceSchema = z.enum(["document", "attachment", "work_product"]);

export const companyArtifactMediaKindSchema = z.enum(["image", "video", "text", "document", "file", "empty"]);

export const companyArtifactGroupBySchema = z.enum(["none", "task", "parent_task"]);

export const companyArtifactsQuerySchema = z.object({
  kind: z.enum(["image", "video", "text", "document", "file", "all"]).optional().default("all"),
  projectId: z.string().uuid().optional(),
  q: z.string().trim().max(COMPANY_ARTIFACTS_MAX_QUERY_LENGTH).optional(),
  groupBy: companyArtifactGroupBySchema.optional().default("none"),
  groupIssueId: z.string().uuid().optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(COMPANY_ARTIFACTS_MAX_LIMIT)
    .optional()
    .default(COMPANY_ARTIFACTS_DEFAULT_LIMIT),
  cursor: z.string().min(1).optional(),
});

export const companyArtifactSchema = z.object({
  id: z.string().min(1),
  source: companyArtifactSourceSchema,
  mediaKind: companyArtifactMediaKindSchema,
  title: z.string(),
  previewText: z.string().nullable(),
  contentType: z.string().nullable(),
  contentPath: z.string().nullable(),
  openPath: z.string().nullable(),
  downloadPath: z.string().nullable(),
  issue: z.object({
    id: z.string().uuid(),
    identifier: z.string(),
    title: z.string(),
  }),
  project: z.object({
    id: z.string().uuid(),
    name: z.string(),
  }).nullable(),
  createdByAgent: z.object({
    id: z.string().uuid(),
    name: z.string(),
  }).nullable(),
  updatedAt: z.string().datetime(),
  href: z.string().min(1),
});

export const companyArtifactGroupSchema = z.object({
  id: z.string().min(1),
  groupBy: companyArtifactGroupBySchema.exclude(["none"]),
  issue: z.object({
    id: z.string().uuid(),
    identifier: z.string(),
    title: z.string(),
  }),
  title: z.string(),
  count: z.number().int().min(0),
  mediaKinds: z.array(companyArtifactMediaKindSchema),
  previewArtifacts: z.array(companyArtifactSchema),
  updatedAt: z.string().datetime(),
  href: z.string().min(1),
});

export const companyArtifactsResponseSchema = z.object({
  artifacts: z.array(companyArtifactSchema),
  groups: z.array(companyArtifactGroupSchema).optional(),
  selectedGroup: companyArtifactGroupSchema.nullable().optional(),
  nextCursor: z.string().nullable(),
});

export type CompanyArtifactsQuery = z.infer<typeof companyArtifactsQuerySchema>;
