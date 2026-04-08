import { AGENT_ROLE_LABELS, type Agent, type CompanyMembership } from "@paperclipai/shared";
import type { InlineEntityOption } from "@/components/InlineEntitySelector";

const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

type PrincipalMembershipLike = {
  principalType: string;
  principalId: string;
};

export function buildAgentMemberOptions(agents: Agent[]): InlineEntityOption[] {
  return [...agents]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((agent) => ({
      id: agent.id,
      label: agent.name,
      searchText: [agent.title, roleLabels[agent.role] ?? agent.role, agent.capabilities]
        .filter(Boolean)
        .join(" "),
    }));
}

export function buildUserMemberOptions(members: CompanyMembership[]): InlineEntityOption[] {
  return members
    .filter((member) => member.principalType === "user" && member.status === "active")
    .sort((left, right) => left.principalId.localeCompare(right.principalId))
    .map((member) => ({
      id: member.principalId,
      label: member.principalId,
      searchText: member.membershipRole ?? "member",
    }));
}

export function resolvePrincipalLabel(
  membership: PrincipalMembershipLike,
  agentById: Map<string, Agent>,
): string {
  if (membership.principalType === "agent") {
    return agentById.get(membership.principalId)?.name ?? membership.principalId;
  }
  return membership.principalId;
}

export function resolvePrincipalSubtitle(
  membership: PrincipalMembershipLike,
  agentById: Map<string, Agent>,
): string | null {
  if (membership.principalType !== "agent") return null;
  const agent = agentById.get(membership.principalId);
  if (!agent) return null;
  return agent.title ?? (roleLabels[agent.role] ?? agent.role);
}
