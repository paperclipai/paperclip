import type { Request } from "express";
import type { HybridOrgNode } from "@paperclipai/shared";

type AgentReadGate = (
  req: Request,
  agent: { id: string; companyId: string },
) => Promise<{ allowed: boolean }>;

export async function filterHybridOrgForActor(
  req: Request,
  nodes: HybridOrgNode[],
  companyId: string,
  decideAgentRead: AgentReadGate,
): Promise<HybridOrgNode[]> {
  if (req.actor.type !== "agent" || !req.actor.agentId) {
    return nodes;
  }
  const filterNode = async (node: HybridOrgNode): Promise<HybridOrgNode[]> => {
    const childLists = await Promise.all(node.reports.map(filterNode));
    const reports = childLists.flat();
    if (node.kind === "user") {
      return reports.length > 0 ? [{ ...node, reports }] : [];
    }
    const decision = await decideAgentRead(req, { id: node.id, companyId });
    if (!decision.allowed) {
      return reports;
    }
    return [{ ...node, reports }];
  };
  const lists = await Promise.all(nodes.map(filterNode));
  return lists.flat();
}
