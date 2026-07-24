export const RESOURCE_MEMBERSHIP_STATES = ["joined", "left"] as const;

export type ResourceMembershipState = (typeof RESOURCE_MEMBERSHIP_STATES)[number];
export type ResourceMembershipResourceType = "project" | "agent";

export interface ResourceMemberships {
  projectMemberships: Record<string, ResourceMembershipState>;
  agentMemberships: Record<string, ResourceMembershipState>;
  starredProjectIds?: string[];
  starredAgentIds?: string[];
  projectStarredAt?: Record<string, Date>;
  agentStarredAt?: Record<string, Date>;
  updatedAt: Date | null;
}

export interface UpdateResourceMembership {
  state?: ResourceMembershipState;
  starred?: boolean;
}

export interface ResourceMembershipUpdateResult {
  resourceType: ResourceMembershipResourceType;
  resourceId: string;
  state: ResourceMembershipState;
  starredAt: Date | null;
  updatedAt: Date;
}
