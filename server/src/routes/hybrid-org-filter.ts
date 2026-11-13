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
  const filterNode = async (node: HybridOrgNode): Promise<HybridOrgNode | null> => {
    const reports = (await Promise.all(node.reports.map(filterNode))).filter((child): child is HybridOrgNode => child !== null);
    if (node.kind === "user") {
      return reports.length > 0 ? { ...node, reports } : null;
    }
    const decision = await decideAgentRead(req, { id: node.id, companyId });
    if (!decision.allowed) {
      return reports.length > 0 ? { ...node, reports } : null;
    }
    return { ...node, reports };
  };
  return (await Promise.all(nodes.map(filterNode))).filter((node): node is HybridOrgNode => node !== null);
}
