import type { Issue } from "./types/issue.js";

export type ResponsibleUserSource = "explicit" | "creator" | "none";

export interface ResponsibleUserAttribution {
  userId: string | null;
  source: ResponsibleUserSource;
  isAutoDerived: boolean;
}

export function deriveResponsibleUser(
  issue: Pick<Issue, "responsibleUserId" | "createdByUserId">,
): ResponsibleUserAttribution {
  if (issue.responsibleUserId) {
    return { userId: issue.responsibleUserId, source: "explicit", isAutoDerived: false };
  }

  if (issue.createdByUserId) {
    return { userId: issue.createdByUserId, source: "creator", isAutoDerived: true };
  }

  return { userId: null, source: "none", isAutoDerived: false };
}
