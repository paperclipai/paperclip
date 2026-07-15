import { z } from "zod";

export const folderKindSchema = z.enum(["routine", "skill"]);
export const folderSlugSchema = z.string().trim().min(1).max(120).regex(
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
  "Folder slug must contain only lowercase letters, numbers, and single hyphens",
);

export const folderSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  kind: folderKindSchema,
  parentId: z.string().uuid().nullable(),
  name: z.string().min(1),
  slug: folderSlugSchema,
  systemKey: z.string().nullable(),
  path: z.string().min(1),
  depth: z.number().int().min(1),
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
  parentId: z.string().uuid().optional().nullable(),
  name: z.string().trim().min(1).max(120),
  slug: folderSlugSchema.optional().nullable(),
  color: z.string().trim().min(1).max(80).optional().nullable(),
  position: z.number().int().min(0).optional().nullable(),
});

export const updateFolderSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  slug: folderSlugSchema.optional(),
  color: z.string().trim().min(1).max(80).optional().nullable(),
  position: z.number().int().min(0).optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: "At least one folder field is required",
});

export const moveFolderSchema = z.object({
  parentId: z.string().uuid().optional().nullable(),
  position: z.number().int().min(0),
});

export const ensureMySkillFolderSchema = z.object({
  slug: folderSlugSchema.optional().nullable(),
}).default({});

export const moveFolderItemSchema = z.object({
  kind: folderKindSchema,
  itemId: z.string().uuid(),
  folderId: z.string().uuid().optional().nullable(),
});

export type CreateFolder = z.infer<typeof createFolderSchema>;
export type UpdateFolder = z.infer<typeof updateFolderSchema>;
export type MoveFolder = z.infer<typeof moveFolderSchema>;
export type MoveFolderItem = z.infer<typeof moveFolderItemSchema>;
export type EnsureMySkillFolder = z.infer<typeof ensureMySkillFolderSchema>;
