import { z } from "zod";

const sidebarOrderedIdSchema = z.string().uuid();

export const sidebarOrderPreferenceSchema = z.object({
  orderedIds: z.array(sidebarOrderedIdSchema).max(500),
  updatedAt: z.coerce.date().nullable(),
});

export const upsertSidebarOrderPreferenceSchema = z.object({
  orderedIds: z.array(sidebarOrderedIdSchema).max(500),
});

export type UpsertSidebarOrderPreference = z.infer<typeof upsertSidebarOrderPreferenceSchema>;
