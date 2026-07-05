import { z } from "zod";

export const folderKindSchema = z.enum(["routine", "skill"]);

export const folderSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  kind: folderKindSchema,
  name: z.string().min(1),
  color: z.string().nullable(),
  position: z.number().int(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const folderListItemSchema = folderSchema.extend({
  itemCount: z.number().int().nonnegative(),
});

export const folderListResultSchema = z.object({
  kind: folderKindSchema,
  folders: z.array(folderListItemSchema),
  allCount: z.number().int().nonnegative(),
  unfiledCount: z.number().int().nonnegative(),
});

export const createFolderSchema = z.object({
  kind: folderKindSchema,
  name: z.string().trim().min(1).max(120),
  color: z.string().trim().min(1).max(80).optional().nullable(),
  position: z.number().int().min(0).optional().nullable(),
});

export const updateFolderSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  color: z.string().trim().min(1).max(80).optional().nullable(),
  position: z.number().int().min(0).optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: "At least one folder field is required",
});

export const moveFolderSchema = z.object({
  position: z.number().int().min(0),
});

export const moveFolderItemSchema = z.object({
  kind: folderKindSchema,
  itemId: z.string().uuid(),
  folderId: z.string().uuid().optional().nullable(),
});

export type CreateFolder = z.infer<typeof createFolderSchema>;
export type UpdateFolder = z.infer<typeof updateFolderSchema>;
export type MoveFolder = z.infer<typeof moveFolderSchema>;
export type MoveFolderItem = z.infer<typeof moveFolderItemSchema>;
