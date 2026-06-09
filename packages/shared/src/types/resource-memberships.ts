export const RESOURCE_MEMBERSHIP_STATES = ["joined", "left"] as const;

export type ResourceMembershipState = (typeof RESOURCE_MEMBERSHIP_STATES)[number];
export type ResourceMembershipResourceType = "project" | "agent";

export interface ResourceMemberships {
  projectMemberships: Record<string, ResourceMembershipState>;
  agentMemberships: Record<string, ResourceMembershipState>;
  updatedAt: Date | null;
}

export interface UpdateResourceMembership {
  state: ResourceMembershipState;
}

export interface ResourceMembershipUpdateResult {
  resourceType: ResourceMembershipResourceType;
  resourceId: string;
  state: ResourceMembershipState;
  updatedAt: Date;
}
