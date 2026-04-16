import { z } from "zod";

const sidebarOrderedIdSchema = z.string().uuid();

const uniqueOrderedIds = (arr: string[]) => new Set(arr).size === arr.length;

export const sidebarOrderPreferenceSchema = z.object({
  orderedIds: z.array(sidebarOrderedIdSchema).max(500).refine(uniqueOrderedIds, "orderedIds must be unique"),
  updatedAt: z.coerce.date().nullable(),
});

export const upsertSidebarOrderPreferenceSchema = z.object({
  orderedIds: z.array(sidebarOrderedIdSchema).max(500).refine(uniqueOrderedIds, "orderedIds must be unique"),
});

export type UpsertSidebarOrderPreference = z.infer<typeof upsertSidebarOrderPreferenceSchema>;
