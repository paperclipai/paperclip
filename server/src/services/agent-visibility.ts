/**
 * Per-user agent visibility resolver — parallel to `issue-visibility.ts`
 * but for the agents list surface.
 *
 * Companies often want their scoped human members (operators without
 * the `agents:view_all` grant) to see only the agents they actually
 * interact with — typically the agents that created / are assigned to
 * issues the user can read, plus the `reports_to` chain above those.
 * That keeps a scoped user out of leadership-only agent rows (CEO,
 * strategy advisors, etc.) without forcing per-agent ACLs.
 *
 * Bypass for the same actor classes as `tasks:view_all`:
 *  - agents (infrastructure principals)
 *  - local-implicit board users
 *  - instance admins
 *  - users with the `agents:view_all` grant
 *
 * Seed (for scoped users) is the set of agents that appear on any
 * issue the user can read, expanded along the `reports_to` chain so
 * the supervisory hierarchy is preserved.
 *
 * @see services/issue-visibility.ts (the issue-side counterpart)
 * @see CONTRIBUTING.md (default-on opt-out semantics)
 */
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues } from "@paperclipai/db";
import type { Request } from "express";
import { forbidden } from "../errors.js";
import { accessService } from "./access.js";

export type AgentVisibility =
  | { readonly mode: "all" }
  | { readonly mode: "scoped"; readonly userId: string };

const ALL: AgentVisibility = { mode: "all" };

/**
 * Resolves what subset of agents the current actor may read.
 */
export async function resolveAgentVisibility(
  db: Db,
  companyId: string,
  actor: Request["actor"],
): Promise<AgentVisibility> {
  if (!actor || actor.type !== "board") return ALL;
  if (actor.source === "local_implicit") return ALL;
  if (actor.isInstanceAdmin) return ALL;

  const userId = actor.userId;
  if (!userId) return ALL;

  const access = accessService(db);
  if (await access.canUser(companyId, userId, "agents:view_all")) {
    return ALL;
  }
  return { mode: "scoped", userId };
}

/**
 * Returns a Drizzle SQL fragment to AND into any `agents`-keyed WHERE clause.
 * For `{ mode: "all" }` callers returns `undefined` so callers can no-op.
 *
 * Seed: agents that touched any issue the user can read (either via the
 * issue's `created_by_agent_id` or `assignee_agent_id`). Then walk the
 * `reports_to` chain upward so the user also sees that agent's supervisor
 * chain — preserves the visible team hierarchy.
 */
export function agentVisibilityCondition(
  vis: AgentVisibility,
  companyId: string,
): SQL<boolean> | undefined {
  if (vis.mode === "all") return undefined;
  return sql<boolean>`
    ${agents.id} IN (
      WITH RECURSIVE visible_issues(id) AS (
        SELECT ${issues.id}
        FROM ${issues}
        WHERE ${issues.companyId} = ${companyId}
          AND (
            ${issues.createdByUserId} = ${vis.userId}
            OR ${issues.assigneeUserId} = ${vis.userId}
            OR ${issues.requestedByUserId} = ${vis.userId}
          )
        UNION
        SELECT ${issues.id}
        FROM ${issues}
        INNER JOIN visible_issues ON ${issues.parentId} = visible_issues.id
        WHERE ${issues.companyId} = ${companyId}
      ),
      seed_agents(id) AS (
        SELECT DISTINCT ${issues.createdByAgentId} AS id
        FROM ${issues}
        WHERE ${issues.companyId} = ${companyId}
          AND ${issues.id} IN (SELECT id FROM visible_issues)
          AND ${issues.createdByAgentId} IS NOT NULL
        UNION
        SELECT DISTINCT ${issues.assigneeAgentId} AS id
        FROM ${issues}
        WHERE ${issues.companyId} = ${companyId}
          AND ${issues.id} IN (SELECT id FROM visible_issues)
          AND ${issues.assigneeAgentId} IS NOT NULL
      ),
      reachable_agents(id) AS (
        SELECT id FROM seed_agents
        UNION
        SELECT ${agents.reportsTo}
        FROM ${agents}
        INNER JOIN reachable_agents ON ${agents.id} = reachable_agents.id
        WHERE ${agents.reportsTo} IS NOT NULL
          AND ${agents.companyId} = ${companyId}
      )
      SELECT id FROM reachable_agents WHERE id IS NOT NULL
    )
  `;
}

/**
 * Single-agent read gate. Throws 403 with the conventional
 * `Missing permission: agents:view_all` message.
 */
export async function assertAgentVisible(
  db: Db,
  companyId: string,
  agentId: string,
  vis: AgentVisibility,
): Promise<void> {
  if (vis.mode === "all") return;
  const cond = agentVisibilityCondition(vis, companyId)!;
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId), cond))
    .limit(1);
  if (rows.length === 0) {
    throw forbidden("Missing permission: agents:view_all");
  }
}
