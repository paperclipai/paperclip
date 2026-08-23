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
 * The bases below are not invented. They are the classification of 190
 * `issue.cross_issue_influence_observed` rows over 2026-08-20..23: 164 of them
 * (86%) fall under these structural relationships, and the 26 that do not are
 * two named patterns (monitor-to-repair-ticket correlation, and the
 * cross-agent handoff PATCH that `AGENTS.md` mandates) which is what
 * `explicit_permission_grant` exists to cover.
 *
 * Nothing here enforces until `CROSS_ISSUE_WRITE_GRANT_ENFORCE_AT` is set —
 * see `evaluateCrossIssueWriteGrant`. Unset means observe: resolve the basis,
 * record what *would* have been refused, allow the write. That mirrors how
 * `CROSS_ISSUE_INFLUENCE_ENFORCE_AT` was rolled out and is the only way the
 * cutover does not strand running agents.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, principalPermissionGrants } from "@paperclipai/db";
import { scopeAllows } from "./authorization.js";

/** Standing grant that covers cross-issue writes with no structural basis. */
export const CROSS_ISSUE_WRITE_PERMISSION_KEY = "issues:cross-write" as const;

/**
 * Ancestor walk depth. Deep enough for every observed tree (the deepest chain
 * in the sample was 3), bounded so a cycle introduced by a future parent edit
 * cannot spin the recursive CTE.
 */
export const CROSS_ISSUE_WRITE_MAX_ANCESTOR_DEPTH = 25;

export const CROSS_ISSUE_WRITE_BASES = [
  "target_is_ancestor_of_source",
  "target_is_descendant_of_source",
  "target_shares_parent_with_source",
  "actor_is_target_assignee",
  "target_has_no_agent_assignee",
  "actor_created_target",
  "same_routine_origin",
  "explicit_permission_grant",
] as const;

export type CrossIssueWriteBasis = (typeof CROSS_ISSUE_WRITE_BASES)[number];

export type CrossIssueWriteAuthority = {
  /** The first basis that held, or null when none did. */
  basis: CrossIssueWriteBasis | null;
  /** Present only when `basis` is `explicit_permission_grant`. */
  grantScope?: Record<string, unknown> | null;
};

type IssueFacts = {
  id: string;
  parentId: string | null;
  projectId: string | null;
  assigneeAgentId: string | null;
  createdByAgentId: string | null;
  originKind: string;
  originId: string | null;
  originFingerprint: string;
};

/**
 * `db` is the transaction handle from `observeCrossIssueInfluence`, so the
 * basis is resolved against the same snapshot that locked the run row. A
 * reparent committed mid-decision cannot flip the answer underneath us.
 */
type BasisReader = Pick<Db, "select" | "execute">;

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

async function explicitGrantScope(
  db: BasisReader,
  companyId: string,
  actorAgentId: string,
): Promise<Record<string, unknown> | null | undefined> {
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
  },
): Promise<CrossIssueWriteAuthority> {
  const facts = await loadIssueFacts(db, input.companyId, [input.sourceIssueId, input.targetIssueId]);
  const source = facts.get(input.sourceIssueId) ?? null;
  const target = facts.get(input.targetIssueId) ?? null;
  // A target that is not readable in this company is not this module's refusal
  // to make — visibility already denied it upstream. Without the row there is
  // no basis to name, so it falls through to deny.
  if (!target) return { basis: null };

  if (target.assigneeAgentId === input.actorAgentId) return { basis: "actor_is_target_assignee" };
  // Already an explicit allow in authorization.ts ("the issue has no agent
  // assignee"). Reproduced here so the inversion does not silently revoke it:
  // 26% of observed traffic is agents reporting onto board-held tickets.
  if (!target.assigneeAgentId) return { basis: "target_has_no_agent_assignee" };
  if (target.createdByAgentId === input.actorAgentId) return { basis: "actor_created_target" };

  if (source) {
    if (source.parentId && source.parentId === target.parentId) {
      return { basis: "target_shares_parent_with_source" };
    }
    if (
      source.originKind === "routine_execution" &&
      source.originId &&
      source.originId === target.originId &&
      source.originKind === target.originKind &&
      source.originFingerprint === target.originFingerprint
    ) {
      return { basis: "same_routine_origin" };
    }

    const ancestors = await loadAncestors(db, input.companyId, [input.sourceIssueId, input.targetIssueId]);
    if (ancestors.get(input.sourceIssueId)?.has(input.targetIssueId)) {
      return { basis: "target_is_ancestor_of_source" };
    }
    if (ancestors.get(input.targetIssueId)?.has(input.sourceIssueId)) {
      return { basis: "target_is_descendant_of_source" };
    }
  }

  const grantScope = await explicitGrantScope(db, input.companyId, input.actorAgentId);
  if (grantScope !== undefined) {
    // `requireStructuredScope` is the whole point: an `issues:cross-write` row
    // with an empty scope must confer nothing, or the grant becomes exactly the
    // company-wide permit this issue exists to remove.
    const covered = await scopeAllows(
      db as Db,
      input.companyId,
      grantScope,
      { projectId: target.projectId, assigneeAgentId: target.assigneeAgentId },
      { requireStructuredScope: true },
    );
    if (covered) return { basis: "explicit_permission_grant", grantScope };
  }

  return { basis: null };
}

export type CrossIssueWriteGrantMode = "observe" | "enforce";

export type CrossIssueWriteGrantDecision = {
  allowed: boolean;
  mode: CrossIssueWriteGrantMode;
  basis: CrossIssueWriteBasis | null;
  enforceAt: string | null;
};

/**
 * Cutover switch. Unset (the shipped default) means observe forever: every
 * write is still allowed and the ones that would have been refused are audited,
 * which is the dataset the enforcement decision needs. Set it to an ISO
 * timestamp to arm the denial from that instant.
 */
export function crossIssueWriteGrantEnforceAt(
  env: NodeJS.ProcessEnv = process.env,
): Date | null {
  const raw = env.CROSS_ISSUE_WRITE_GRANT_ENFORCE_AT?.trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  // An unparseable date must not read as "enforce now" or as a silent skip of
  // an intended cutover — fail to the safe side and stay in observe.
  return Number.isNaN(parsed.getTime()) ? null : parsed;
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
    enforceAt: enforceAt ? enforceAt.toISOString() : null,
  };
}
