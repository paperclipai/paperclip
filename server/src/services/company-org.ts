import { and, eq } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import type { HybridOrgNode, OrgPrincipalRef } from "@paperclipai/shared";
import { isUuidLike, orgPrincipalKey } from "@paperclipai/shared";
import { agentRecordQueries } from "../lib/agent-records.js";
import { assertHybridReportingAcyclic } from "./company-reporting-graph.js";
import { loadActiveHumanMembers, loadStaffProfilesByUserId } from "./company-staff-profiles.js";

function resolveManagerKey(
  manager: OrgPrincipalRef | null,
  agentIds: Set<string>,
  userIds: Set<string>,
): string | null {
  if (!manager) return null;
  if (manager.type === "agent" && agentIds.has(manager.id)) return orgPrincipalKey(manager);
  if (manager.type === "user" && userIds.has(manager.id)) return orgPrincipalKey(manager);
  return null;
}

function buildForest<T extends { id: string; managerKey: string | null }>(
  nodes: T[],
  makeNode: (node: T, reports: HybridOrgNode[]) => HybridOrgNode,
): HybridOrgNode[] {
  const byManager = new Map<string | null, T[]>();
  const nodeIds = new Set(nodes.map((node) => node.id));
  for (const node of nodes) {
    const parent = node.managerKey && nodeIds.has(node.managerKey) ? node.managerKey : null;
    const group = byManager.get(parent) ?? [];
    group.push(node);
    byManager.set(parent, group);
  }
  const build = (parentKey: string | null, visited: Set<string>): HybridOrgNode[] => {
    const members = byManager.get(parentKey) ?? [];
    return members.map((member) => {
      if (visited.has(member.id)) {
        return makeNode(member, []);
      }
      const nextVisited = new Set(visited);
      nextVisited.add(member.id);
      return makeNode(member, build(member.id, nextVisited));
    }).sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  };
  return build(null, new Set());
}

export async function hybridOrgForCompany(db: Db, companyId: string): Promise<HybridOrgNode[]> {
  const { listCompanyAgentRows, normalizeAgentRows } = agentRecordQueries(db);
  const allCompanyRows = await listCompanyAgentRows(companyId);
  const agentRows = allCompanyRows.filter((row) => row.status !== "terminated");
  const normalizedAgents = normalizeAgentRows(agentRows, allCompanyRows);
  const humans = await loadActiveHumanMembers(db, companyId);
  const staffProfiles = await loadStaffProfilesByUserId(db, companyId);

  const agentIds = new Set(normalizedAgents.map((agent) => agent.id));
  const userIds = new Set(humans.map((human) => human.userId));

  const flattened: Array<{
    id: string;
    kind: "agent" | "user";
    name: string;
    role: string;
    title: string | null;
    status: string;
    managerKey: string | null;
  }> = [];

  for (const agent of normalizedAgents) {
    const manager = agent.reportsToUserId
      ? resolveManagerKey({ type: "user", id: agent.reportsToUserId }, agentIds, userIds)
      : agent.reportsTo
        ? resolveManagerKey({ type: "agent", id: agent.reportsTo }, agentIds, userIds)
        : null;
    flattened.push({
      id: agent.id,
      kind: "agent",
      name: agent.name,
      role: agent.role,
      title: agent.title ?? null,
      status: agent.status,
      managerKey: manager,
    });
  }

  for (const human of humans) {
    const profile = staffProfiles.get(human.userId);
    const manager = profile?.reportsToPrincipalType && profile.reportsToPrincipalId
      ? resolveManagerKey({
        type: profile.reportsToPrincipalType as "agent" | "user",
        id: profile.reportsToPrincipalId,
      }, agentIds, userIds)
      : null;
    flattened.push({
      id: human.userId,
      kind: "user",
      name: human.displayName,
      role: profile?.orgRole?.trim() || human.membershipRole || "member",
      title: profile?.jobTitle ?? null,
      status: human.status,
      managerKey: manager,
    });
  }

  return buildForest(
    flattened.map((node) => ({ ...node, id: `${node.kind}:${node.id}` })),
    (node, reports) => ({
      id: node.id.slice(node.kind.length + 1),
      kind: node.kind,
      name: node.name,
      role: node.role,
      title: node.title,
      status: node.status,
      reports,
    }),
  );
}

export async function assertAgentReportsToPrincipal(
  db: Db,
  companyId: string,
  agentId: string,
  reportsTo: string | null | undefined,
  reportsToUserId: string | null | undefined,
): Promise<void> {
  if (reportsTo && reportsToUserId) {
    throw new Error("An agent cannot report to both an agent and a human");
  }
  if (reportsToUserId) {
    if (isUuidLike(reportsToUserId)) {
      const [agent] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, reportsToUserId)));
      if (agent) throw new Error("reportsToUserId cannot reference an agent id");
    }
    const humans = await loadActiveHumanMembers(db, companyId);
    if (!humans.some((human) => human.userId === reportsToUserId)) {
      throw new Error("reportsToUserId must reference an active company member");
    }
  }
  if (reportsTo) {
    const [manager] = await db
      .select({ id: agents.id, status: agents.status })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.id, reportsTo)));
    if (!manager || manager.id === agentId || manager.status === "terminated") {
      throw new Error("Invalid reports-to agent");
    }
  }
  const self: OrgPrincipalRef = { type: "agent", id: agentId };
  const manager: OrgPrincipalRef | null = reportsToUserId
    ? { type: "user", id: reportsToUserId }
    : reportsTo
      ? { type: "agent", id: reportsTo }
      : null;
  await assertHybridReportingAcyclic(db, companyId, self, manager);
}
