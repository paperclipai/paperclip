import type { Db } from "@paperclipai/db";
import type { OrgPrincipalRef } from "@paperclipai/shared";
import { orgPrincipalKey } from "@paperclipai/shared";
import { agentRecordQueries } from "../lib/agent-records.js";
import { badRequest } from "../errors.js";
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

async function loadReportingParentMap(db: Db, companyId: string): Promise<Map<string, string | null>> {
  const { listCompanyAgentRows, normalizeAgentRows } = agentRecordQueries(db);
  const allCompanyRows = await listCompanyAgentRows(companyId);
  const agentRows = allCompanyRows.filter((row) => row.status !== "terminated");
  const normalizedAgents = normalizeAgentRows(agentRows, allCompanyRows);
  const humans = await loadActiveHumanMembers(db, companyId);
  const staffProfiles = await loadStaffProfilesByUserId(db, companyId);
  const agentIds = new Set(normalizedAgents.map((agent) => agent.id));
  const userIds = new Set(humans.map((human) => human.userId));
  const parents = new Map<string, string | null>();
  for (const agent of normalizedAgents) {
    const selfKey = orgPrincipalKey({ type: "agent", id: agent.id });
    if (!selfKey) continue;
    const manager = agent.reportsToUserId
      ? resolveManagerKey({ type: "user", id: agent.reportsToUserId }, agentIds, userIds)
      : agent.reportsTo
        ? resolveManagerKey({ type: "agent", id: agent.reportsTo }, agentIds, userIds)
        : null;
    parents.set(selfKey, manager);
  }
  for (const human of humans) {
    const selfKey = orgPrincipalKey({ type: "user", id: human.userId });
    if (!selfKey) continue;
    const profile = staffProfiles.get(human.userId);
    const manager = profile?.reportsToPrincipalType && profile.reportsToPrincipalId
      ? resolveManagerKey({
        type: profile.reportsToPrincipalType as "agent" | "user",
        id: profile.reportsToPrincipalId,
      }, agentIds, userIds)
      : null;
    parents.set(selfKey, manager);
  }
  return parents;
}

function reportingEdgeCreatesCycle(
  parents: Map<string, string | null>,
  nodeKey: string,
  managerKey: string | null,
): boolean {
  const nextParents = new Map(parents);
  nextParents.set(nodeKey, managerKey);
  if (!managerKey) return false;
  const visited = new Set<string>();
  let current: string | null = managerKey;
  while (current) {
    if (current === nodeKey) return true;
    if (visited.has(current)) return false;
    visited.add(current);
    current = nextParents.get(current) ?? null;
  }
  return false;
}

export async function assertHybridReportingAcyclic(
  db: Db,
  companyId: string,
  node: OrgPrincipalRef,
  reportsTo: OrgPrincipalRef | null,
): Promise<void> {
  const nodeKey = orgPrincipalKey(node);
  if (!nodeKey) return;
  const managerKey = reportsTo ? orgPrincipalKey(reportsTo) : null;
  const parents = await loadReportingParentMap(db, companyId);
  if (reportingEdgeCreatesCycle(parents, nodeKey, managerKey)) {
    throw badRequest("Reporting relationship would create a cycle in the org chart");
  }
}
