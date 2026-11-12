import type { OrgNode } from "../../api/agents";
import type { ChartTask } from "./tasks";

/** Development-only fixtures; these never create issues or start agent runs. */
export function createTaskPreview(roots: OrgNode[]): ChartTask[] {
  const nodes: OrgNode[] = [];
  const visit = (node: OrgNode) => { nodes.push(node); node.reports.forEach(visit); };
  roots.forEach(visit);
  if (!nodes.length) return [];
  const engineering = nodes.find(node => node.role === "cto") ?? nodes.find(node => node.reports.length) ?? nodes[0];
  const marketing = nodes.find(node => node.role === "cmo") ?? nodes[0];
  const engineer = engineering.reports.find(node => node.role === "engineer") ?? engineering.reports[0] ?? engineering;
  const reviewer = nodes.find(node => node.role === "qa") ?? nodes.at(-1)!;
  return [
    { id: "preview-launch", title: "Plan product launch", identifier: null, ownerId: marketing.id, agentIds: [marketing.id] },
    { id: "preview-onboarding", title: "Build onboarding flow", identifier: null, ownerId: engineering.id, agentIds: [...new Set([engineering.id, engineer.id])] },
    { id: "preview-release", title: "Review release readiness", identifier: null, ownerId: reviewer.id, agentIds: [reviewer.id] },
  ];
}
