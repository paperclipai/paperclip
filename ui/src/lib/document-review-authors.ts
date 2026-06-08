import type { Agent, IssueCommentAuthorType } from "@paperclipai/shared";
import type { CompanyUserProfile } from "@/lib/company-members";

export interface ReviewAuthorMaps {
  agentMap?: ReadonlyMap<string, Pick<Agent, "id" | "name">>;
  userProfileMap?: ReadonlyMap<string, CompanyUserProfile>;
}

export interface ReviewAuthorRef {
  authorType?: IssueCommentAuthorType;
  authorAgentId?: string | null;
  authorUserId?: string | null;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
}

export interface ResolvedReviewAuthor {
  name: string;
  role: "board" | "agent";
}

/**
 * Resolve the display name + role for any document-review entity (annotation
 * comment, review comment, suggestion, suggestion comment). Falls back to a
 * truncated id, then to a generic "Agent"/"Board" label. Mirrors the resolver
 * used by `DocumentAnnotationPanel` so author chips read consistently.
 */
export function resolveReviewAuthor(ref: ReviewAuthorRef, maps: ReviewAuthorMaps): ResolvedReviewAuthor {
  const agentId = ref.authorAgentId ?? ref.createdByAgentId ?? null;
  const userId = ref.authorUserId ?? ref.createdByUserId ?? null;
  if (agentId) {
    const agent = maps.agentMap?.get(agentId);
    return { name: agent?.name ?? agentId.slice(0, 8), role: "agent" };
  }
  if (userId) {
    const profile = maps.userProfileMap?.get(userId);
    return { name: profile?.label ?? userId.slice(0, 8), role: "board" };
  }
  const isAgent = ref.authorType === "agent";
  return { name: isAgent ? "Agent" : "Board", role: isAgent ? "agent" : "board" };
}
