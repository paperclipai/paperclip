/**
 * Per-user issue visibility resolver.
 *
 * Paperclip's coarse access model is membership + role + named permission
 * grants. By default every active member of a company can read every issue
 * in that company. For deployments where finer scoping is needed (e.g. a
 * human assistant who should only see their own work plus its derivatives),
 * the `tasks:view_all` permission key acts as an opt-out: when an admin
 * revokes the grant from a member, that member's reads scope to:
 *
 *   - issues where they are `createdByUserId` or `assigneeUserId`, plus
 *   - the transitive `parent_id` descendants of those issues.
 *
 * Agents, instance admins, and local-implicit users are never scoped.
 *
 * The recursive CTE mirrors the existing `descendantOf` filter pattern at
 * services/issues.ts so its plan stays predictable on Postgres.
 *
 * @see CONTRIBUTING.md (default-on opt-out semantics)
 * @see services/access.ts (canUser instance-admin short-circuit)
 */
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import type { Request } from "express";
import { forbidden } from "../errors.js";
import { accessService } from "./access.js";

export type IssueVisibility =
  | { readonly mode: "all" }
  | { readonly mode: "scoped"; readonly userId: string };

const ALL: IssueVisibility = { mode: "all" };

/**
 * Resolves what subset of issues the current actor may read.
 *
 * Returns `{ mode: "all" }` for:
 *  - agents (infrastructure principals — never scoped)
 *  - local-implicit board users (single-user trusted mode)
 *  - instance admins
 *  - users with the `tasks:view_all` grant
 *
 * Returns `{ mode: "scoped", userId }` for human users who lack the grant.
 */
export async function resolveIssueVisibility(
  db: Db,
  companyId: string,
  actor: Request["actor"],
): Promise<IssueVisibility> {
  if (!actor || actor.type !== "board") return ALL;
  if (actor.source === "local_implicit") return ALL;
  if (actor.isInstanceAdmin) return ALL;

  const userId = actor.userId;
  if (!userId) return ALL;

  const access = accessService(db);
  if (await access.canUser(companyId, userId, "tasks:view_all")) {
    return ALL;
  }
  return { mode: "scoped", userId };
}

/**
 * Returns a Drizzle SQL fragment to AND into any `issues`-keyed WHERE clause.
 * For `{ mode: "all" }` callers returns `undefined` so callers can no-op.
 */
export function issueVisibilityCondition(
  vis: IssueVisibility,
  companyId: string,
): SQL<boolean> | undefined {
  if (vis.mode === "all") return undefined;
  return sql<boolean>`
    ${issues.id} IN (
      WITH RECURSIVE owned(id) AS (
        SELECT ${issues.id}
        FROM ${issues}
        WHERE ${issues.companyId} = ${companyId}
          AND (
            ${issues.createdByUserId} = ${vis.userId}
            OR ${issues.assigneeUserId} = ${vis.userId}
          )
        UNION
        SELECT ${issues.id}
        FROM ${issues}
        INNER JOIN owned ON ${issues.parentId} = owned.id
        WHERE ${issues.companyId} = ${companyId}
      )
      SELECT id FROM owned
    )
  `;
}

/**
 * Single-issue read gate. Throws 403 with the `Missing permission:
 * tasks:view_all` message that matches the project convention
 * (`tests/routines-routes.test.ts` precedent for permission denial).
 */
export async function assertIssueVisible(
  db: Db,
  companyId: string,
  issueId: string,
  vis: IssueVisibility,
): Promise<void> {
  if (vis.mode === "all") return;
  const cond = issueVisibilityCondition(vis, companyId)!;
  const rows = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId), cond))
    .limit(1);
  if (rows.length === 0) {
    throw forbidden("Missing permission: tasks:view_all");
  }
}

/**
 * Convenience for callers that need both the visibility object and the
 * single-issue gate in one shot — common in route handlers.
 */
export async function requireIssueAccess(
  db: Db,
  companyId: string,
  issueId: string,
  actor: Request["actor"],
): Promise<IssueVisibility> {
  const vis = await resolveIssueVisibility(db, companyId, actor);
  await assertIssueVisible(db, companyId, issueId, vis);
  return vis;
}
