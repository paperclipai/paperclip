import { and, eq, sql } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import { MAX_AGENT_TASK_HIERARCHY_DEPTH, type IssueParentAdjustment } from "@paperclipai/shared";

/**
 * `flatten` (the default) applies the agent hierarchy limit: a new parent edge
 * may not make the task deeper than MAX_AGENT_TASK_HIERARCHY_DEPTH. Board users
 * pass `allow_nested` and may build trees of any depth.
 */
export type IssueParentDepthPolicy = "flatten" | "allow_nested";

/** One issue on the path from a requested parent up to its tree root. */
export type ParentChainRow = {
  id: string;
  identifier: string | null;
  parentId: string | null;
  conversationAgentId: string | null;
  executionPolicy: unknown;
};

export type ParentPlacement = { effectiveParentId: string | null; adjustment: IssueParentAdjustment | null };

/** Bound on ancestor walks; real trees are far shallower, and cycles stop here. */
const MAX_PARENT_CHAIN_LENGTH = 64;

/** Root of a low-trust authorization boundary recorded on an issue's execution policy. */
function lowTrustBoundaryRootIssueId(executionPolicy: unknown): string | null {
  const policy = executionPolicy as { authorizationPolicy?: { trustBoundary?: { rootIssueId?: unknown } | null } | null } | null;
  const root = policy?.authorizationPolicy?.trustBoundary?.rootIssueId;
  return typeof root === "string" && root.length > 0 ? root : null;
}

/**
 * Places a new parent edge given the requested parent's ancestor chain
 * (`chain[0]` is the requested parent, the last entry its root). Under
 * `flatten`, a parent already at the maximum depth is replaced by its ancestor
 * at the allowed depth, which makes the task a sibling of the requester. Never
 * throws for depth.
 */
export function placeTaskParent(chain: ParentChainRow[], policy: IssueParentDepthPolicy): ParentPlacement {
  const requested = chain[0];
  if (!requested || policy === "allow_nested") {
    return { effectiveParentId: requested?.id ?? null, adjustment: null };
  }
  // A parent at depth d (root = 1) gives the new task depth d + 1.
  const maxParentDepth = MAX_AGENT_TASK_HIERARCHY_DEPTH - 1;
  if (chain.length <= maxParentDepth) return { effectiveParentId: requested.id, adjustment: null };
  const targetIndex = chain.length - maxParentDepth;
  // Low-trust boundaries are subtrees. Never move a task above the root of a
  // boundary that contains the requester; keep the requested parent instead.
  const boundaryRoots = new Set(chain.flatMap((row) => lowTrustBoundaryRootIssueId(row.executionPolicy) ?? []));
  if (chain.slice(0, Math.max(targetIndex, 0)).some((row) => boundaryRoots.has(row.id))) {
    return { effectiveParentId: requested.id, adjustment: null };
  }
  const target = maxParentDepth > 0 ? chain[targetIndex] : null;
  // Conversations never take new children; legacy trees under one fall back to top level.
  const effective = target && !target.conversationAgentId ? target : null;
  return {
    effectiveParentId: effective?.id ?? null,
    adjustment: {
      reason: "max_agent_depth",
      applied: true,
      requestedParent: { id: requested.id, identifier: requested.identifier },
      effectiveParent: effective ? { id: effective.id, identifier: effective.identifier } : null,
    },
  };
}

/** Loads a requested parent's ancestor chain in one recursive query. Empty when it does not exist. */
export async function loadParentChain(
  db: Pick<Db, "execute">,
  companyId: string,
  parentId: string,
): Promise<ParentChainRow[]> {
  const result = await db.execute(sql`
    WITH RECURSIVE chain AS (
      SELECT ${issues.id} AS id, ${issues.identifier} AS identifier, ${issues.parentId} AS parent_id,
        ${issues.conversationAgentId} AS conversation_agent_id, ${issues.executionPolicy} AS execution_policy,
        1 AS depth, ARRAY[${issues.id}] AS path
      FROM ${issues}
      WHERE ${issues.companyId} = ${companyId} AND ${issues.id} = ${parentId}
      UNION ALL
      SELECT parent.id, parent.identifier, parent.parent_id, parent.conversation_agent_id, parent.execution_policy,
        chain.depth + 1, chain.path || parent.id
      FROM ${issues} AS parent
      JOIN chain ON parent.id = chain.parent_id
      WHERE parent.company_id = ${companyId}
        AND NOT parent.id = ANY(chain.path)
        AND chain.depth < ${MAX_PARENT_CHAIN_LENGTH}
    )
    SELECT id, identifier, parent_id, conversation_agent_id, execution_policy FROM chain ORDER BY depth
  `);
  const rows = (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? []) as Array<{
    id: string; identifier: string | null; parent_id: string | null; conversation_agent_id: string | null; execution_policy: unknown;
  }>;
  return rows.map((row) => ({
    id: row.id,
    identifier: row.identifier,
    parentId: row.parent_id,
    conversationAgentId: row.conversation_agent_id,
    executionPolicy: row.execution_policy,
  }));
}

/** Loads an ancestor chain one issue at a time through a caller-supplied, company-scoped reader. */
export async function loadParentChainWith(
  load: (id: string) => Promise<ParentChainRow | null>,
  parentId: string,
): Promise<ParentChainRow[]> {
  const chain: ParentChainRow[] = [];
  const visited = new Set<string>();
  let nextId: string | null = parentId;
  while (nextId && !visited.has(nextId) && chain.length < MAX_PARENT_CHAIN_LENGTH) {
    visited.add(nextId);
    const row = await load(nextId);
    if (!row) break;
    chain.push(row);
    nextId = row.parentId;
  }
  return chain;
}

/**
 * Resolves the parent a new edge should use. Unknown parents pass through
 * unchanged so the caller's own existence and authorization checks still apply.
 */
export async function resolveNewTaskParent(
  db: Pick<Db, "execute">,
  companyId: string,
  requestedParentId: string | null | undefined,
  policy: IssueParentDepthPolicy = "flatten",
): Promise<ParentPlacement> {
  if (!requestedParentId || policy === "allow_nested") {
    return { effectiveParentId: requestedParentId ?? null, adjustment: null };
  }
  const chain = await loadParentChain(db, companyId, requestedParentId);
  if (chain.length === 0) return { effectiveParentId: requestedParentId, adjustment: null };
  return placeTaskParent(chain, policy);
}

/**
 * Plans a parent change for an existing issue from the requested parent's
 * chain. Under `flatten`, a move into a child is placed beside it, and a move
 * of an issue that has its own children is skipped (`parentId: undefined`),
 * since either would create grandchildren. Never throws for depth.
 */
export function planParentChange(
  existing: { parentId: string | null },
  chain: ParentChainRow[],
  requestedParentId: string,
  hasChildren: boolean,
  currentParent: { id: string; identifier: string | null } | null,
  policy: IssueParentDepthPolicy,
): { parentId: string | null | undefined; adjustment: IssueParentAdjustment | null } {
  const requested = chain[0];
  if (policy === "allow_nested" || requestedParentId === existing.parentId || !requested) {
    return { parentId: requestedParentId, adjustment: null };
  }
  if (hasChildren) {
    return {
      parentId: undefined,
      adjustment: {
        reason: "has_children",
        applied: false,
        requestedParent: { id: requested.id, identifier: requested.identifier },
        effectiveParent: currentParent,
      },
    };
  }
  const placement = placeTaskParent(chain, "flatten");
  return { parentId: placement.effectiveParentId, adjustment: placement.adjustment };
}

/** Database-backed {@link planParentChange} for the issue service. */
export async function planIssueParentChange(
  db: Pick<Db, "execute" | "select">,
  existing: { id: string; companyId: string; parentId: string | null },
  requestedParentId: string,
  policy: IssueParentDepthPolicy = "flatten",
) {
  if (policy === "allow_nested" || requestedParentId === existing.parentId) {
    return { parentId: requestedParentId as string | null | undefined, adjustment: null as IssueParentAdjustment | null };
  }
  const chain = await loadParentChain(db, existing.companyId, requestedParentId);
  const [child] = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.companyId, existing.companyId), eq(issues.parentId, existing.id)))
    .limit(1);
  const [currentParent] = existing.parentId && child ? await db
    .select({ id: issues.id, identifier: issues.identifier })
    .from(issues)
    .where(and(eq(issues.companyId, existing.companyId), eq(issues.id, existing.parentId))) : [];
  return planParentChange(existing, chain, requestedParentId, Boolean(child), currentParent ?? null, policy);
}

/** Adds `parentAdjusted` to a create/update result only when the parent was adjusted. */
export function withParentAdjustment<T extends object>(
  issue: T,
  adjustment: IssueParentAdjustment | null,
): T & { parentAdjusted?: IssueParentAdjustment } {
  return adjustment ? { ...issue, parentAdjusted: adjustment } : issue;
}
