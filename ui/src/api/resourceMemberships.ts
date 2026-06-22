import type {
  ResourceMemberships,
  ResourceMembershipUpdateResult,
  UpdateResourceMembership,
} from "@paperclipai/shared";
import { api } from "./client";

export const resourceMembershipsApi = {
  listMine: (companyId: string) =>
    api.get<ResourceMemberships>(`/companies/${companyId}/resource-memberships/me`),
  updateProject: (companyId: string, projectId: string, data: UpdateResourceMembership) =>
    api.put<ResourceMembershipUpdateResult>(
      `/companies/${companyId}/resource-memberships/me/projects/${projectId}`,
      data,
    ),
  updateAgent: (companyId: string, agentId: string, data: UpdateResourceMembership) =>
    api.put<ResourceMembershipUpdateResult>(
      `/companies/${companyId}/resource-memberships/me/agents/${agentId}`,
      data,
    ),
};
