import type { Agent, KnowledgeItem } from "@paperclipai/shared";

export function resolveKnowledgeActorLabel({
  agentId,
  userId,
  agents,
  currentUserId,
}: {
  agentId: string | null | undefined;
  userId: string | null | undefined;
  agents: Pick<Agent, "id" | "name">[] | null | undefined;
  currentUserId: string | null | undefined;
}): string {
  if (agentId) {
    const agent = (agents ?? []).find((candidate) => candidate.id === agentId);
    if (agent?.name) return agent.name;
    return agentId.slice(0, 8);
  }

  if (userId) {
    if (userId === "local-board") return "Board";
    if (currentUserId && userId === currentUserId) return "Me";
    return userId.slice(0, 8);
  }

  return "Unknown";
}

export function getKnowledgeAuthorshipLabels(
  item: Pick<KnowledgeItem, "createdByAgentId" | "createdByUserId" | "updatedByAgentId" | "updatedByUserId">,
  context: {
    agents: Pick<Agent, "id" | "name">[] | null | undefined;
    currentUserId: string | null | undefined;
  },
) {
  return {
    createdBy: resolveKnowledgeActorLabel({
      agentId: item.createdByAgentId,
      userId: item.createdByUserId,
      agents: context.agents,
      currentUserId: context.currentUserId,
    }),
    updatedBy: resolveKnowledgeActorLabel({
      agentId: item.updatedByAgentId,
      userId: item.updatedByUserId,
      agents: context.agents,
      currentUserId: context.currentUserId,
    }),
  };
}
