import { z } from "zod";

const sidebarOrderedIdSchema = z.string().uuid();

export const sidebarOrderPreferenceSchema = z.object({
  orderedIds: z.array(sidebarOrderedIdSchema),
  updatedAt: z.coerce.date().nullable(),
});

export const upsertSidebarOrderPreferenceSchema = z.object({
  orderedIds: z.array(sidebarOrderedIdSchema),
});

export type UpsertSidebarOrderPreference = z.infer<typeof upsertSidebarOrderPreferenceSchema>;
