import { z } from "zod";

/** Instance-personal presentation preference. Never changes company capabilities. */
export interface WorkspacePreference {
  userId: string;
  coordinatorWorkspaceEnabled: boolean;
  /** IANA time zone reported by the person's browser, or null when unknown. */
  timeZone: string | null;
  updatedAt: string | null;
}

export const WORKSPACE_PREFERENCE_TIME_ZONE_MAX_LENGTH = 64;

/** True when the runtime recognizes the value as an IANA time zone name. */
export function isValidIanaTimeZone(value: string): boolean {
  if (!value || value.length > WORKSPACE_PREFERENCE_TIME_ZONE_MAX_LENGTH) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const updateWorkspacePreferenceSchema = z.object({
  coordinatorWorkspaceEnabled: z.boolean().optional(),
  timeZone: z.string().trim().min(1).max(WORKSPACE_PREFERENCE_TIME_ZONE_MAX_LENGTH)
    .refine(isValidIanaTimeZone, { message: "Use an IANA time zone such as America/Chicago" })
    .optional(),
}).strict().refine(
  value => value.coordinatorWorkspaceEnabled !== undefined || value.timeZone !== undefined,
  { message: "Provide coordinatorWorkspaceEnabled or timeZone" },
);

export type UpdateWorkspacePreference = z.infer<typeof updateWorkspacePreferenceSchema>;
