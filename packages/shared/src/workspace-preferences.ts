import { z } from "zod";

/** Instance-personal presentation preference. Never changes company capabilities. */
export interface WorkspacePreference {
  userId: string;
  coordinatorWorkspaceEnabled: boolean;
  updatedAt: string | null;
}

export const updateWorkspacePreferenceSchema = z.object({
  coordinatorWorkspaceEnabled: z.boolean(),
}).strict();

export type UpdateWorkspacePreference = z.infer<typeof updateWorkspacePreferenceSchema>;
