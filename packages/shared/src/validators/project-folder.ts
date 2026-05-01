import { z } from "zod";

export const createProjectFolderSchema = z.object({
  name: z.string().min(1).max(100),
  sortOrder: z.number().int().optional(),
});

export type CreateProjectFolder = z.infer<typeof createProjectFolderSchema>;

export const updateProjectFolderSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  sortOrder: z.number().int().optional(),
});

export type UpdateProjectFolder = z.infer<typeof updateProjectFolderSchema>;

export const reorderProjectFoldersSchema = z.object({
  orderedIds: z.array(z.string().uuid()),
});

export type ReorderProjectFolders = z.infer<typeof reorderProjectFoldersSchema>;
