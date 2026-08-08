import { and, eq, ne } from "drizzle-orm";
import { agents } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { normalizeAgentUrlKey, ORG_CHART_TOO_LARGE_ERROR } from "@paperclipai/shared";
import type { Agent } from "@paperclipai/shared";

export { ORG_CHART_TOO_LARGE_ERROR } from "@paperclipai/shared";

const MAX_DESCENDANTS = 500;

type AgentRow = typeof agents.$inferSelect;

function toAgent(row: AgentRow): Agent {
  // DB schema stores enum fields as string; the cast is safe because Drizzle
  // constrains values at the insert/migration layer. urlKey and spentMonthlyCents
  // are not stored in agents rows — derive them here.
  return {
    ...row,
    urlKey: normalizeAgentUrlKey(row.name) ?? row.id,
    spentMonthlyCents: 0,
  } as unknown as Agent;
}

function buildChildrenMap(rows: AgentRow[]): Map<string, AgentRow[]> {
  const map = new Map<string, AgentRow[]>();
  for (const row of rows) {
    if (!row.reportsTo) continue;
    const siblings = map.get(row.reportsTo) ?? [];
    siblings.push(row);
    map.set(row.reportsTo, siblings);
  }
  return map;
}

/**
 * Returns all non-terminated descendants of agentId within companyId.
 * Uses a single company-scoped DB query + in-memory BFS. Visited-set
 * prevents infinite loops if a cycle exists in data.
 * Throws ORG_CHART_TOO_LARGE_ERROR if result exceeds MAX_DESCENDANTS.
 */
export async function getDescendants(
  db: Db,
  agentId: string,
  companyId: string,
): Promise<Agent[]> {
  const rows = await db
    .select()
    .from(agents)
    .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));

  // Verify agentId is in this company
  const root = rows.find((r) => r.id === agentId);
  if (!root) return [];

  const childrenMap = buildChildrenMap(rows);
  const visited = new Set<string>([agentId]);
  const queue: AgentRow[] = [...(childrenMap.get(agentId) ?? [])];
  const result: AgentRow[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    result.push(current);
    if (result.length > MAX_DESCENDANTS) {
      throw new Error(ORG_CHART_TOO_LARGE_ERROR);
    }
    const children = childrenMap.get(current.id) ?? [];
    queue.push(...children);
  }

  return result
    .sort((a, b) => {
      const nameComp = a.name.localeCompare(b.name);
      return nameComp !== 0 ? nameComp : a.id.localeCompare(b.id);
    })
    .map(toAgent);
}

/**
 * Returns the non-terminated parent of agentId within companyId, or null.
 * Returns null if agentId not in company, has no reportsTo, or parent is
 * in a different company (cross-company FK guard).
 */
export async function getParent(
  db: Db,
  agentId: string,
  companyId: string,
): Promise<Agent | null> {
  const rows = await db
    .select()
    .from(agents)
    .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));

  const byId = new Map(rows.map((r) => [r.id, r]));
  const agent = byId.get(agentId);
  if (!agent || !agent.reportsTo) return null;

  // Parent must also be in the same company (defensive cross-company guard)
  const parent = byId.get(agent.reportsTo);
  if (!parent) return null;

  return toAgent(parent);
}

/**
 * Returns true if candidateId is a descendant of ancestorId within companyId.
 * Walks reportsTo chain upward through ALL statuses (hierarchy is structural).
 * Returns false for same ID, nonexistent IDs, wrong-company IDs.
 */
export async function isDescendantOf(
  db: Db,
  candidateId: string,
  ancestorId: string,
  companyId: string,
): Promise<boolean> {
  if (candidateId === ancestorId) return false;

  // Load all agents for company (all statuses — structural traversal)
  const rows = await db
    .select()
    .from(agents)
    .where(eq(agents.companyId, companyId));

  const byId = new Map(rows.map((r) => [r.id, r]));

  // Verify both IDs are in this company
  if (!byId.has(candidateId) || !byId.has(ancestorId)) return false;

  const visited = new Set<string>([candidateId]);
  let current = byId.get(candidateId)!;

  while (current.reportsTo) {
    if (current.reportsTo === ancestorId) return true;
    if (visited.has(current.reportsTo)) break; // cycle guard
    visited.add(current.reportsTo);
    const next = byId.get(current.reportsTo);
    if (!next) break; // parent not in company (cross-company FK)
    current = next;
  }

  return false;
}
