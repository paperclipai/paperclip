import { and, eq, sql } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import { MAX_AGENT_TASK_HIERARCHY_DEPTH, type IssueParentAdjustment } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

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

/**
 * Parent-write validation walks the requested parent's ancestors only this
 * many rows before it stops trusting its own answer. Healthy trees resolve
 * far above it (agent trees are capped at MAX_AGENT_TASK_HIERARCHY_DEPTH),
 * and the bound keeps a deep board-built tree from turning every PATCH into
 * an unbounded ancestor walk. A chain deeper than the window falls back to
 * the full walk under {@link PARENT_WRITE_VALIDATION_STATEMENT_TIMEOUT_MS}.
 */
export const PARENT_WRITE_VALIDATION_DEPTH_CAP = 64;

/** Statement timeout (milliseconds) for the full-ancestor fallback walk. */
export const PARENT_WRITE_VALIDATION_STATEMENT_TIMEOUT_MS = 5_000;

// Placement walks stay uncapped: placement needs the real root even for
// legacy trees deeper than any fixed bound, and both placement loaders stop
// on a cycle. Parent-write validation walks a bounded window instead (see
// {@link PARENT_WRITE_VALIDATION_DEPTH_CAP}) and falls back to the full walk,
// under a statement timeout, only when the window cannot answer.

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

/**
 * Callers authorize the parent they request. When depth placement moves a task
 * above that parent, the ancestor is written only if the caller also authorized
 * it and says so with `expectedParentId` (the routes and the runner do). Other
 * callers get standalone work instead: no structural parent, never an edge
 * under an ancestor nobody checked.
 */
export function confirmPlacement(placement: ParentPlacement, expectedParentId: string | null | undefined): ParentPlacement {
  if (expectedParentId !== undefined || !placement.adjustment?.applied || placement.effectiveParentId === null) {
    return placement;
  }
  return { effectiveParentId: null, adjustment: { ...placement.adjustment, effectiveParent: null } };
}

function parentChainRows(result: unknown): ParentChainRow[] {
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
    )
    SELECT id, identifier, parent_id, conversation_agent_id, execution_policy FROM chain ORDER BY depth
  `);
  return parentChainRows(result);
}

/**
 * Loads a requested parent's ancestor chain bounded to
 * {@link PARENT_WRITE_VALIDATION_DEPTH_CAP} rows for cycle validation. The
 * recursion guards on depth instead of a visited-path array, so the walk does
 * O(cap) work no matter how deep or tangled the tree is. The window's answer
 * is final when its last row reaches the root, or when an id repeats (the
 * walk looped inside a cycle, which the uncapped walk stops at anyway); a
 * chain cut off mid-way needs the full walk to decide.
 */
export async function loadParentChainBounded(
  db: Pick<Db, "execute">,
  companyId: string,
  parentId: string,
): Promise<ParentChainRow[]> {
  const result = await db.execute(sql`
    WITH RECURSIVE chain AS (
      SELECT ${issues.id} AS id, ${issues.identifier} AS identifier, ${issues.parentId} AS parent_id,
        ${issues.conversationAgentId} AS conversation_agent_id, ${issues.executionPolicy} AS execution_policy,
        1 AS depth
      FROM ${issues}
      WHERE ${issues.companyId} = ${companyId} AND ${issues.id} = ${parentId}
      UNION ALL
      SELECT parent.id, parent.identifier, parent.parent_id, parent.conversation_agent_id, parent.execution_policy,
        chain.depth + 1
      FROM ${issues} AS parent
      JOIN chain ON parent.id = chain.parent_id
      WHERE parent.company_id = ${companyId}
        AND chain.depth < ${PARENT_WRITE_VALIDATION_DEPTH_CAP}
    )
    SELECT id, identifier, parent_id, conversation_agent_id, execution_policy FROM chain ORDER BY depth
  `);
  return parentChainRows(result);
}

/** Loads an ancestor chain one issue at a time through a caller-supplied, company-scoped reader. */
export async function loadParentChainWith(
  load: (id: string) => Promise<ParentChainRow | null>,
  parentId: string,
): Promise<ParentChainRow[]> {
  const chain: ParentChainRow[] = [];
  const visited = new Set<string>();
  let nextId: string | null = parentId;
  while (nextId && !visited.has(nextId)) {
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

/** Cycle decision returned by {@link assertParentWriteAllowed}. */
export type ParentWriteValidation = {
  /** Chain the cycle decision was made on. */
  chain: ParentChainRow[];
  /** True when `chain` is the complete uncapped walk, safe to reuse for placement. */
  chainComplete: boolean;
};

/** True when an issue id appears twice on the chain: the walk looped inside a cycle. */
function chainLoops(chain: ParentChainRow[]): boolean {
  const seen = new Set<string>();
  for (const row of chain) {
    if (seen.has(row.id)) return true;
    seen.add(row.id);
  }
  return false;
}

function rejectParentCycle(chain: ParentChainRow[], requestedParentId: string): never {
  // Looping chains can repeat ids in the bounded window; name each ancestor once.
  const seen = new Set<string>();
  const labels = chain
    .filter((row) => !seen.has(row.id) && (seen.add(row.id), true))
    .map((row) => row.identifier ?? row.id)
    .join(" → ");
  throw unprocessable(
    `Moving this task under ${chain[0]?.identifier ?? requestedParentId} would create a parent cycle: it is already an ancestor of the new parent (${labels})`,
    { code: "issue_parent_cycle" },
  );
}

/**
 * Rejects a self-parent request and any explicit parent write whose proposed
 * parent already has the moving issue as an ancestor (a cycle, including
 * re-affirming a poisoned edge already in the data) with a 422
 * `issue_parent_cycle` error. Exported so the update path can also validate a
 * repeated write whose value equals the stored parent — that stored edge can
 * itself be poisoned. Validation is bounded: the ancestor window resolves
 * healthy chains and loops inside {@link PARENT_WRITE_VALIDATION_DEPTH_CAP},
 * and only a chain deeper than the window pays one full walk under
 * {@link PARENT_WRITE_VALIDATION_STATEMENT_TIMEOUT_MS}.
 */
export async function assertParentWriteAllowed(
  db: Pick<Db, "execute" | "transaction">,
  existing: { id: string; companyId: string; parentId: string | null },
  requestedParentId: string,
): Promise<ParentWriteValidation> {
  // A poisoned self-edge (`parent_id = id`) once made every subtree walk over
  // the tree recurse forever, so no policy accepts one, and a write whose
  // proposed parent already has the moving issue as an ancestor would close
  // (or perpetuate) the same kind of cycle.
  if (requestedParentId === existing.id) {
    throw unprocessable("An issue cannot be its own parent", { code: "issue_parent_cycle" });
  }
  // The bounded window answers outright for healthy chains and chains that
  // loop inside the cap; a healthy walk cannot contain the moving issue, so
  // seeing it there means the proposed parent sits below the issue in the tree.
  const chain = await loadParentChainBounded(db, existing.companyId, requestedParentId);
  const chainComplete = chain.length > 0 && chain[chain.length - 1].parentId === null;
  if (chain.some(row => row.id === existing.id)) {
    rejectParentCycle(chain, requestedParentId);
  }
  if (!chainComplete && !chainLoops(chain) && chain.length === PARENT_WRITE_VALIDATION_DEPTH_CAP) {
    // Cut off mid-chain with no loop: the tree is deeper than the window (or
    // rooted past a dangling link), so only the full walk can answer. Run it
    // once under a statement timeout, then restore the caller's previous
    // setting: this helper can run inside the caller's open transaction (the
    // nested transaction is a savepoint) and `set_config` with `is_local` is
    // transaction-scoped, so resetting to '0' (unlimited) would clobber any
    // operator-configured limit for the rest of that transaction.
    const full = await db.transaction(async (tx) => {
      // missing_ok: NULL/'' means no limit is configured — restoring '0' is
      // then the same unlimited value, not a clobber. The savepoint rollback
      // already reverts local settings when the walk itself times out.
      const [previous] = await tx.execute<{ statementTimeout: string | null }>(
        sql`select current_setting('statement_timeout', true) as "statementTimeout"`,
      );
      await tx.execute(sql`select set_config('statement_timeout', ${`${PARENT_WRITE_VALIDATION_STATEMENT_TIMEOUT_MS}ms`}, true)`);
      const rows = await loadParentChain(tx as Pick<Db, "execute">, existing.companyId, requestedParentId);
      await tx.execute(sql`select set_config('statement_timeout', ${previous?.statementTimeout || "0"}, true)`);
      return rows;
    });
    if (full.some(row => row.id === existing.id)) {
      rejectParentCycle(full, requestedParentId);
    }
    return { chain: full, chainComplete: true };
  }
  return { chain, chainComplete };
}

/**
 * Database-backed {@link planParentChange} for the issue service. Rejects
 * cycle-creating parent writes (see {@link assertParentWriteAllowed});
 * cross-company and unknown parents are rejected downstream by the caller's
 * company check.
 */
export async function planIssueParentChange(
  db: Pick<Db, "execute" | "transaction" | "select">,
  existing: { id: string; companyId: string; parentId: string | null },
  requestedParentId: string,
  policy: IssueParentDepthPolicy = "flatten",
) {
  const { chain: validatedChain, chainComplete } = await assertParentWriteAllowed(db, existing, requestedParentId);
  if (requestedParentId === existing.parentId) {
    return { parentId: requestedParentId as string | null | undefined, adjustment: null as IssueParentAdjustment | null };
  }
  if (policy === "allow_nested") {
    return { parentId: requestedParentId as string | null | undefined, adjustment: null as IssueParentAdjustment | null };
  }
  const [child] = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.companyId, existing.companyId), eq(issues.parentId, existing.id)))
    .limit(1);
  const [currentParent] = existing.parentId && child ? await db
    .select({ id: issues.id, identifier: issues.identifier })
    .from(issues)
    .where(and(eq(issues.companyId, existing.companyId), eq(issues.id, existing.parentId))) : [];
  // Placement needs the real root, so a chain the bounded validation window
  // cut short is loaded in full here; resolved chains are reused as-is.
  const chain = chainComplete ? validatedChain : await loadParentChain(db, existing.companyId, requestedParentId);
  return planParentChange(existing, chain, requestedParentId, Boolean(child), currentParent ?? null, policy);
}

/** Adds `parentAdjusted` to a create/update result only when the parent was adjusted. */
export function withParentAdjustment<T extends object>(
  issue: T,
  adjustment: IssueParentAdjustment | null,
): T & { parentAdjusted?: IssueParentAdjustment } {
  return adjustment ? { ...issue, parentAdjusted: adjustment } : issue;
}
