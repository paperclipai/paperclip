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

/**
 * The actor to display as an issue's "Originating" attribution.
 *
 * A human creator always wins (`createdByUserId`). When an agent created the
 * issue but a transitive human responsible user is known, we attribute the
 * originator to that human and record the creating agent as `viaAgentId` so the
 * UI can show a "via <agent>" affordance. Agent-only creators fall back to the
 * agent, and routine executions (no `createdBy*`) surface the responsible user.
 */
export type OriginatingActor =
  | { kind: "user"; id: string; viaAgentId?: string }
  | { kind: "agent"; id: string };

export function deriveOriginatingActor(
  issue: Pick<Issue, "createdByUserId" | "createdByAgentId" | "responsibleUserId">,
): OriginatingActor | null {
  if (issue.createdByUserId) {
    return { kind: "user", id: issue.createdByUserId };
  }

  if (issue.createdByAgentId) {
    if (issue.responsibleUserId) {
      return { kind: "user", id: issue.responsibleUserId, viaAgentId: issue.createdByAgentId };
    }
    return { kind: "agent", id: issue.createdByAgentId };
  }

  if (issue.responsibleUserId) {
    return { kind: "user", id: issue.responsibleUserId };
  }

  return null;
}
