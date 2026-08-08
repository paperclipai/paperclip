import { z } from "zod";

const uuid = () => z.string().uuid();

export const createAgentFolderSchema = z.object({
  parentId: uuid().optional().nullable(),
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().min(1).max(120).optional().nullable(),
  sortOrder: z.number().int().min(0).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const updateAgentFolderSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    slug: z.string().trim().min(1).max(120).optional().nullable(),
    sortOrder: z.number().int().min(0).optional(),
    metadata: z.record(z.unknown()).optional().nullable(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one folder field is required",
  });

export const moveAgentFolderSchema = z.object({
  parentId: uuid().optional().nullable(),
  sortOrder: z.number().int().min(0).optional(),
});

/**
 * Reassign a single agent to a folder. `folderId: null` unassigns.
 */
export const moveAgentToFolderSchema = z.object({
  folderId: uuid().optional().nullable(),
});

export type CreateAgentFolder = z.infer<typeof createAgentFolderSchema>;
export type UpdateAgentFolder = z.infer<typeof updateAgentFolderSchema>;
export type MoveAgentFolder = z.infer<typeof moveAgentFolderSchema>;
export type MoveAgentToFolder = z.infer<typeof moveAgentToFolderSchema>;
