import { z } from "zod";

export const artifactFolderSourceTypeSchema = z.enum(["project", "issue", "custom"]);

export const createArtifactFolderSchema = z.union([
  z.object({
    parentId: z.string().uuid().optional().nullable(),
    name: z.string().min(1).max(255),
  }),
  z.object({
    path: z.string().min(1).max(1024),
  }),
]);

export type CreateArtifactFolder = z.infer<typeof createArtifactFolderSchema>;

export const updateArtifactFolderSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  parentId: z.string().uuid().nullable().optional(),
});

export type UpdateArtifactFolder = z.infer<typeof updateArtifactFolderSchema>;

export const createArtifactSchema = z.object({
  folderId: z.string().uuid().optional(),
  path: z.string().min(1).max(1024).optional(),
  issueId: z.string().uuid().optional().nullable(),
  title: z.string().min(1).max(255).optional(),
  description: z.string().max(4096).optional().nullable(),
});

export type CreateArtifact = z.infer<typeof createArtifactSchema>;

export const updateArtifactSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  description: z.string().max(4096).nullable().optional(),
  folderId: z.string().uuid().optional(),
});

export type UpdateArtifact = z.infer<typeof updateArtifactSchema>;

export const listArtifactsQuerySchema = z.object({
  folderId: z.string().uuid().optional(),
  issueId: z.string().uuid().optional(),
  agentId: z.string().uuid().optional(),
  mimeType: z.string().optional(),
  search: z.string().optional(),
  sort: z.enum(["name", "createdAt", "size"]).optional().default("createdAt"),
  order: z.enum(["asc", "desc"]).optional().default("desc"),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export type ListArtifactsQuery = z.infer<typeof listArtifactsQuerySchema>;
