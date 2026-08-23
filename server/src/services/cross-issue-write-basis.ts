/**
 * Deny-by-default authority for agent writes that land outside the run's own
 * issue (FAI-10132, the policy half of the FAI-9983 security review).
 *
 * The permit-by-default rule this replaces lives in `authorization.ts`: a
 * standard-trust agent may write to *any* issue it can see in its own company
 * (`allow_visible_issue_write`), and the 20-per-run cross-issue cap is applied
 * on top of that. Security asked for the inverse — name a basis first, then
 * count against the cap — so a prompt-injected agent's reach is its own work
 * tree rather than the whole company for the life of its run.
 *
 * Every basis here is a *structural* relationship between the run's own issue
 * and the target, or an exact scoped grant. There is deliberately no basis of
 * the shape "the target happens to be unassigned": that was the FAI-10134
 * blocking finding 2 — it left every board-held and human-held ticket in the
 * company writable by any standard agent, 20 per run, which is the reach this
 * issue exists to remove. Traffic that legitimately reports onto a board-held
 * ticket is covered by the delegation tree (ancestor/descendant) or, for a
 * standing routing duty, by an `issues:cross-write` grant scoped to the
 * projects or assignees it covers.
 *
 * Authority is also split by operation (FAI-10134 finding 2, second half). The
 * two weakest links — "we share a parent" and "we came from the same routine" —
 * are correlations, not delegation. They carry enough standing to *say*
 * something on the other ticket and no standing to change its state, so they
 * authorize comments only; a PATCH or an interaction resolution needs a basis
 * that names real authority over the target.
 *
 * Nothing here enforces until `CROSS_ISSUE_WRITE_GRANT_ENFORCE_AT` is set —
 * see `evaluateCrossIssueWriteGrant`. Unset means observe: resolve the basis,
 * record what *would* have been refused, allow the write. That mirrors how
 * `CROSS_ISSUE_INFLUENCE_ENFORCE_AT` was rolled out and is the only way the
 * cutover does not strand running agents. An unset switch observes; an
 * *invalid* switch is a startup failure, not a silent downgrade to observe.
 *
 * Time-of-check/time-of-use: the basis is resolved twice. Once in the counter
 * transaction, before the cap is spent, so an unauthorized write never spends
 * budget; and once more inside the transaction that actually persists the
 * mutation, via `assertCrossIssueWriteFence`, which takes `FOR SHARE` locks on
 * every row the decision reads — the two endpoints, the ancestor chain between
 * them, and the grant row. A reassignment, reparent, or grant revocation either
 * commits before those locks (the re-resolution sees it and the mutation rolls
 * back with zero rows written) or blocks behind them until the mutation
 * commits. That closes FAI-10134 blocking finding 1.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, principalPermissionGrants } from "@paperclipai/db";
import { scopeAllows } from "./authorization.js";
import {
  CROSS_ISSUE_WRITE_GRANT_ENFORCE_AT_ENV,
  parseCrossIssueWriteGrantEnforceAt,
} from "./cross-issue-write-enforcement-config.js";

export {
  CROSS_ISSUE_WRITE_GRANT_ENFORCE_AT_ENV,
  CrossIssueWriteGrantConfigError,
  assertCrossIssueWriteGrantEnforceAtConfig,
  parseCrossIssueWriteGrantEnforceAt,
} from "./cross-issue-write-enforcement-config.js";

/** Standing grant that covers cross-issue writes with no structural basis. */
export const CROSS_ISSUE_WRITE_PERMISSION_KEY = "issues:cross-write" as const;

/**
 * Ancestor walk depth. Deep enough for every observed tree (the deepest chain
 * in the sample was 3), bounded so a cycle introduced by a future parent edit
 * cannot spin the recursive CTE.
 */
export const CROSS_ISSUE_WRITE_MAX_ANCESTOR_DEPTH = 25;

/**
 * How many times the locked ancestry walk may re-walk before it gives up. Two
 * rounds is the quiet case (walk, lock, confirm); a reparent landing in the gap
 * costs one more. The bound is a backstop against a reparent storm, and it fails
 * closed — see `loadAncestorsUnderLock`.
 */
export const CROSS_ISSUE_WRITE_ANCESTOR_LOCK_ROUNDS = 4;

export const CROSS_ISSUE_WRITE_BASES = [
  "target_is_ancestor_of_source",
  "target_is_descendant_of_source",
  "target_shares_parent_with_source",
  "actor_is_target_assignee",
  "actor_created_target",
  "same_routine_origin",
  "explicit_permission_grant",
] as const;

export type CrossIssueWriteBasis = (typeof CROSS_ISSUE_WRITE_BASES)[number];

/**
 * What the write is about to do. A comment adds a message to a thread; a
 * mutation changes issue state or resolves an interaction on someone else's
 * ticket. The second needs the stronger basis.
 */
export type CrossIssueWriteOperation = "comment" | "mutation";

/**
 * Bases that authorize a comment and nothing more. "Same parent" and "same
 * routine execution" say the two tickets are *related*; neither says this agent
 * has authority over the target.
 */
export const CROSS_ISSUE_WRITE_COMMENT_ONLY_BASES: ReadonlySet<CrossIssueWriteBasis> = new Set([
  "target_shares_parent_with_source",
  "same_routine_origin",
]);

export function crossIssueWriteBasisAuthorizes(
  basis: CrossIssueWriteBasis,
  operation: CrossIssueWriteOperation,
) {
  return operation === "comment" || !CROSS_ISSUE_WRITE_COMMENT_ONLY_BASES.has(basis);
}

export type CrossIssueWriteAuthority = {
  /** The first basis that held for this operation, or null when none did. */
  basis: CrossIssueWriteBasis | null;
  /** Present only when `basis` is `explicit_permission_grant`. */
  grantScope?: Record<string, unknown> | null;
  /**
   * Set when a basis held for a comment but not for this mutation. Recorded so
   * the shadow dataset can separate "no relationship at all" from "related, but
   * only far enough to comment".
   */
  commentOnlyBasis?: CrossIssueWriteBasis | null;
  /** Whether the target is held by a human. Audit context, never a basis. */
  targetAssigneeUserId?: string | null;
};

type IssueFacts = {
  id: string;
  parentId: string | null;
  projectId: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  createdByAgentId: string | null;
  originKind: string;
  originId: string | null;
  originFingerprint: string;
};

/**
 * `db` is the transaction handle from `observeCrossIssueInfluence` or from the
 * route's persistence transaction, so the basis is resolved against one
 * snapshot. With `lockAuthorityInputs` the reads also take `FOR SHARE`, which
 * is what makes the persistence-time re-resolution binding through commit.
 */
type BasisReader = Pick<Db, "select" | "execute">;

type ResolveOptions = {
  /**
   * Take `FOR SHARE` on every row the decision reads. Use inside the
   * transaction that persists the write: a concurrent reassignment, reparent,
   * or grant revocation then cannot commit between the check and the write.
   */
  lockAuthorityInputs?: boolean;
};

async function lockIssueRows(db: BasisReader, companyId: string, issueIds: string[]) {
  const distinct = [...new Set(issueIds)];
  if (distinct.length === 0) return;
  // Raw SQL because drizzle's `.for()` builder is not available on every
  // transaction handle shape this module is called with, and the lock is the
  // only thing this statement is for.
  await db.execute(sql`
    SELECT id FROM issues
    WHERE company_id = ${companyId}
      AND id IN (${sql.join(distinct.map((id) => sql`${id}`), sql`, `)})
    FOR SHARE
  `);
}

async function loadIssueFacts(
  db: BasisReader,
  companyId: string,
  issueIds: string[],
): Promise<Map<string, IssueFacts>> {
  const rows = await db
    .select({
      id: issues.id,
      parentId: issues.parentId,
      projectId: issues.projectId,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
      createdByAgentId: issues.createdByAgentId,
      originKind: issues.originKind,
      originId: issues.originId,
      originFingerprint: issues.originFingerprint,
    })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds)));
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Ancestors of both endpoints in one recursive walk, tagged by which endpoint
 * seeded them. Two upward walks answer both directions of the tree question:
 * the target is the source's ancestor if it shows up in the source's chain,
 * and the source's descendant if the source shows up in the target's chain.
 */
async function loadAncestors(
  db: BasisReader,
  companyId: string,
  seedIds: string[],
): Promise<Map<string, Set<string>>> {
  const rows = await db.execute(sql`
    WITH RECURSIVE chain(seed, id, parent_id, depth) AS (
      SELECT seeded.id, seeded.id, seeded.parent_id, 0
      FROM issues seeded
      WHERE seeded.company_id = ${companyId}
        AND seeded.id IN (${sql.join(seedIds.map((id) => sql`${id}`), sql`, `)})
      UNION ALL
      SELECT chain.seed, parent.id, parent.parent_id, chain.depth + 1
      FROM issues parent
      JOIN chain ON parent.id = chain.parent_id
      WHERE parent.company_id = ${companyId}
        AND chain.depth < ${CROSS_ISSUE_WRITE_MAX_ANCESTOR_DEPTH}
    )
    SELECT seed, id FROM chain WHERE depth > 0
  `);

  const bySeed = new Map<string, Set<string>>(seedIds.map((id) => [id, new Set<string>()]));
  for (const row of Array.isArray(rows) ? rows : []) {
    const { seed, id } = row as { seed: string; id: string };
    bySeed.get(seed)?.add(id);
  }
  return bySeed;
}

/**
 * Ancestry that is still true when the transaction commits.
 *
 * `loadAncestors` walks unlocked rows, so locking the chain that walk returned
 * and then trusting the walk itself leaves open the exact gap the lock exists to
 * close: a reparent committing between the walk and the lock is invisible to the
 * decision, and the mutation lands on authority that no longer holds. Walking
 * again after the lock closes it — once every edge a walk relied on is held
 * `FOR SHARE`, a repeat walk returning the same chain proves that chain cannot
 * move before commit, because changing it means updating a locked row.
 *
 * Each round only ever adds rows the previous round had not seen and the walk is
 * depth-capped, so it converges; exhausting the bound returns empty ancestry,
 * which denies the two tree bases rather than authorizing from an unconfirmed
 * walk.
 */
async function loadAncestorsUnderLock(
  db: BasisReader,
  companyId: string,
  seedIds: string[],
): Promise<Map<string, Set<string>>> {
  // Both endpoints are already locked by the caller.
  const locked = new Set(seedIds);
  let previous: Map<string, Set<string>> | null = null;
  for (let round = 0; round < CROSS_ISSUE_WRITE_ANCESTOR_LOCK_ROUNDS; round += 1) {
    const walked = await loadAncestors(db, companyId, seedIds);
    if (previous && sameAncestry(previous, walked)) return walked;
    const unlocked = [...walked.values()]
      .flatMap((ids) => [...ids])
      .filter((id) => !locked.has(id));
    // Lock every edge the walk relied on. A reparent anywhere in the chain
    // rewrites one of these rows, so it now blocks behind the mutation.
    await lockIssueRows(db, companyId, unlocked);
    for (const id of unlocked) locked.add(id);
    previous = walked;
  }
  return new Map(seedIds.map((id) => [id, new Set<string>()]));
}

function sameAncestry(a: Map<string, Set<string>>, b: Map<string, Set<string>>): boolean {
  if (a.size !== b.size) return false;
  for (const [seed, ids] of a) {
    const other = b.get(seed);
    if (!other || other.size !== ids.size) return false;
    for (const id of ids) if (!other.has(id)) return false;
  }
  return true;
}

async function explicitGrantScope(
  db: BasisReader,
  companyId: string,
  actorAgentId: string,
  lock: boolean,
): Promise<Record<string, unknown> | null | undefined> {
  if (lock) {
    // `FOR SHARE` on the grant row: a revocation racing the mutation either
    // lands before this and is seen, or waits for the mutation's transaction.
    await db.execute(sql`
      SELECT id FROM principal_permission_grants
      WHERE company_id = ${companyId}
        AND principal_type = 'agent'
        AND principal_id = ${actorAgentId}
        AND permission_key = ${CROSS_ISSUE_WRITE_PERMISSION_KEY}
      FOR SHARE
    `);
  }
  const grant = await db
    .select({ scope: principalPermissionGrants.scope })
    .from(principalPermissionGrants)
    .where(and(
      eq(principalPermissionGrants.companyId, companyId),
      eq(principalPermissionGrants.principalType, "agent"),
      eq(principalPermissionGrants.principalId, actorAgentId),
      eq(principalPermissionGrants.permissionKey, CROSS_ISSUE_WRITE_PERMISSION_KEY),
    ))
    .then((rows) => rows[0] ?? null);
  return grant ? grant.scope : undefined;
}

/**
 * Resolve the first basis that authorizes `actorAgentId` to write to
 * `targetIssueId` from a run checked out on `sourceIssueId`.
 *
 * Order is cheapest-first among the structural bases; the grant lookup is last
 * because it is the only one that touches a second table. Returning the *first*
 * match is deliberate — the audit row should name the narrowest reason the
 * write was allowed, not the broadest.
 */
export async function resolveCrossIssueWriteBasis(
  db: BasisReader,
  input: {
    companyId: string;
    actorAgentId: string;
    sourceIssueId: string;
    targetIssueId: string;
    operation: CrossIssueWriteOperation;
  },
  options: ResolveOptions = {},
): Promise<CrossIssueWriteAuthority> {
  const lock = options.lockAuthorityInputs === true;
  if (lock) await lockIssueRows(db, input.companyId, [input.sourceIssueId, input.targetIssueId]);

  const facts = await loadIssueFacts(db, input.companyId, [input.sourceIssueId, input.targetIssueId]);
  const source = facts.get(input.sourceIssueId) ?? null;
  const target = facts.get(input.targetIssueId) ?? null;
  // A target that is not readable in this company is not this module's refusal
  // to make — visibility already denied it upstream. Without the row there is
  // no basis to name, so it falls through to deny.
  if (!target) return { basis: null };

  const targetAssigneeUserId = target.assigneeUserId ?? null;
  // The first basis that held for *any* operation, kept so a mutation refused
  // for being comment-grade is distinguishable in the audit trail from a write
  // with no relationship at all.
  let commentOnlyBasis: CrossIssueWriteBasis | null = null;
  const accept = (basis: CrossIssueWriteBasis): CrossIssueWriteAuthority | null => {
    if (crossIssueWriteBasisAuthorizes(basis, input.operation)) {
      return { basis, commentOnlyBasis: null, targetAssigneeUserId };
    }
    commentOnlyBasis ??= basis;
    return null;
  };
  const deny = (): CrossIssueWriteAuthority => ({ basis: null, commentOnlyBasis, targetAssigneeUserId });

  if (target.assigneeAgentId === input.actorAgentId) {
    const held = accept("actor_is_target_assignee");
    if (held) return held;
  }
  if (target.createdByAgentId === input.actorAgentId) {
    const held = accept("actor_created_target");
    if (held) return held;
  }

  if (source) {
    if (source.parentId && source.parentId === target.parentId) {
      const held = accept("target_shares_parent_with_source");
      if (held) return held;
    }
    if (
      source.originKind === "routine_execution" &&
      source.originId &&
      source.originId === target.originId &&
      source.originKind === target.originKind &&
      source.originFingerprint === target.originFingerprint
    ) {
      const held = accept("same_routine_origin");
      if (held) return held;
    }

    const seeds = [input.sourceIssueId, input.targetIssueId];
    const ancestors = lock
      ? await loadAncestorsUnderLock(db, input.companyId, seeds)
      : await loadAncestors(db, input.companyId, seeds);
    if (ancestors.get(input.sourceIssueId)?.has(input.targetIssueId)) {
      const held = accept("target_is_ancestor_of_source");
      if (held) return held;
    }
    if (ancestors.get(input.targetIssueId)?.has(input.sourceIssueId)) {
      const held = accept("target_is_descendant_of_source");
      if (held) return held;
    }
  }

  const grantScope = await explicitGrantScope(db, input.companyId, input.actorAgentId, lock);
  if (grantScope !== undefined) {
    // `requireStructuredScope` rejects an empty scope; `requireRecognizedConstraint`
    // rejects a *non-empty* scope that constrains nothing this evaluator
    // understands (`{"note":"scoped"}`). Without the second one an unrecognized
    // key set reads as "unconstrained but non-empty" and the grant silently
    // becomes exactly the company-wide permit this issue exists to remove
    // (FAI-10134 blocking finding 3).
    const covered = await scopeAllows(
      db as Db,
      input.companyId,
      grantScope,
      { projectId: target.projectId, assigneeAgentId: target.assigneeAgentId },
      { requireStructuredScope: true, requireRecognizedConstraint: true },
    );
    if (covered) {
      const held = accept("explicit_permission_grant");
      if (held) return { ...held, grantScope };
    }
  }

  return deny();
}

export type CrossIssueWriteGrantMode = "observe" | "enforce";

export type CrossIssueWriteGrantDecision = {
  allowed: boolean;
  mode: CrossIssueWriteGrantMode;
  basis: CrossIssueWriteBasis | null;
  commentOnlyBasis: CrossIssueWriteBasis | null;
  targetAssigneeUserId: string | null;
  enforceAt: string | null;
};

/**
 * Cutover switch. Unset (the shipped default) means observe forever: every
 * write is still allowed and the ones that would have been refused are audited,
 * which is the dataset the enforcement decision needs. Set it to an ISO
 * timestamp to arm the denial from that instant. An unparseable value throws —
 * see `parseCrossIssueWriteGrantEnforceAt`; `loadConfig` calls the same parser
 * at startup so this never surfaces mid-request.
 */
export function crossIssueWriteGrantEnforceAt(
  env: NodeJS.ProcessEnv = process.env,
): Date | null {
  return parseCrossIssueWriteGrantEnforceAt(env[CROSS_ISSUE_WRITE_GRANT_ENFORCE_AT_ENV]);
}

export function evaluateCrossIssueWriteGrant(input: {
  authority: CrossIssueWriteAuthority;
  now?: Date;
  enforceAt?: Date | null;
}): CrossIssueWriteGrantDecision {
  const now = input.now ?? new Date();
  const enforceAt = input.enforceAt === undefined ? crossIssueWriteGrantEnforceAt() : input.enforceAt;
  const mode: CrossIssueWriteGrantMode = enforceAt && now >= enforceAt ? "enforce" : "observe";
  return {
    allowed: input.authority.basis !== null || mode === "observe",
    mode,
    basis: input.authority.basis,
    commentOnlyBasis: input.authority.commentOnlyBasis ?? null,
    targetAssigneeUserId: input.authority.targetAssigneeUserId ?? null,
    enforceAt: enforceAt ? enforceAt.toISOString() : null,
  };
}
