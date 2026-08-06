import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { eq } from "drizzle-orm";

import { evaluateAgentInvokability, type AgentOrgRow } from "./agent-invokability.js";

/**
 * Deterministic fallback ownership for issues created without an assignee.
 *
 * An issue with `assigneeAgentId: null` and `assigneeUserId: null` is picked up by no
 * heartbeat, ever, regardless of priority. It is not in anyone's queue -- it is invisible.
 * The orphan detector keys on first-class blocker links, so an unassigned issue with no
 * blocker edge is invisible to it by construction: there is no edge to traverse.
 *
 * This module closes the creation path. The ladder below is evaluated in order and the
 * first *invokable* (wakeable) agent wins. "Invokable" is the same predicate the runtime
 * uses to decide whether an agent can be woken at all, so a fallback owner is guaranteed
 * to be a real, wakeable owner rather than a paused/terminated/broken-org-chain agent.
 *
 *   1. `parent`  -- the parent issue's assignee. Child work inherits its parent's owner.
 *   2. `creator_manager` -- the creating agent's nearest invokable manager, walking
 *      `reportsTo` upward. An agent that files work without naming an owner is escalating
 *      to their management chain, which is what a human would do.
 *   3. `creator` -- the creating agent itself, when it has no invokable manager.
 *   4. `company_root` -- the company root agent (`reportsTo IS NULL`), i.e. the CEO.
 *
 * ## Fail visible, never fail closed
 *
 * When every rung misses we still create the issue. Rejecting the create would mean "the
 * roster is degraded, therefore no new issue may be filed" -- which slams the door shut at
 * exactly the moment someone needs to file an escalation, an incident, or a blocker. That
 * converts a silent failure into a loud, total, company-wide write outage and calls it a
 * safety improvement.
 *
 * Weigh the two failure modes honestly:
 *   - Invisible issue: the work exists, is queryable, and is recoverable the moment anyone
 *     looks. Bad, but recoverable.
 *   - Rejected create: the work never exists. The caller gets an error, moves on, and the
 *     content is gone. There is nothing to recover, because nothing was written.
 *
 * An issue that exists with a warning flag beats an issue that was never created. Always.
 *
 * So at the bottom of the ladder we assign the company root even when it is not currently
 * invokable -- an owner who is merely paused is still an owner, and pausing is reversible --
 * and mark the result `degraded` with `degradedReason: "no_invokable_owner"`. That flag is
 * persisted first-class on the issue so a degraded roster produces a *worklist*
 * (`scripts/rbr767-sweep.ts`) rather than an outage.
 *
 * ## Zero agents is a bootstrap state, not an impossibility
 *
 * An earlier revision of this module rejected one case: `no_agents_in_company`. That was
 * wrong, and it was the same fail-closed sentence in a narrower window -- "this company
 * has no staff, therefore no one may write anything down." Zero agents is the bootstrap
 * state of every company that has ever existed: someone has to be able to file the first
 * issue, including the issue that says "hire the first agent."
 *
 * So there is now NO input on which the create route refuses to write. At zero agents we
 * return `applied: false` with `degradedReason: "no_agents_in_company"`: the issue is
 * created unassigned and flagged. `applied: false` means "no owner was named," never
 * "reject." The row drains through the identical sweep path as any other degraded row the
 * moment an agent exists -- no new machinery.
 *
 * Backlog is deliberately NOT excluded. A backlog issue still gets a deterministic owner;
 * it simply does not generate an assignment wake (existing behaviour for `status: backlog`).
 * Owning and waking are separate concerns -- an unowned backlog item is still invisible
 * work, it is just invisible work nobody has promised to do yet.
 */

export type IssueAssigneeFallbackReason =
  | "parent"
  | "creator_manager"
  | "creator"
  | "company_root";

/**
 * Why an issue is flagged for the sweep.
 *
 *  - `no_invokable_owner`  -- an owner was named, but none of the ladder's rungs were
 *    invokable, so the row landed on a paused/terminated owner of last resort.
 *  - `no_agents_in_company` -- the company has zero agents, so no owner could be named at
 *    all. The issue is created unassigned and flagged.
 *
 * Both are persisted first-class on the issue so the sweep can find them without scraping
 * activity text, and both clear through the same path once a row lands on an invokable
 * owner.
 */
export type IssueAssigneeDegradedReason = "no_invokable_owner" | "no_agents_in_company";

export type IssueAssigneeFallbackResult =
  /** An explicit assignee was supplied; the ladder did not run. */
  | { applied: false; reason: "explicit" }
  /** A rung produced a genuinely invokable owner. The healthy path. */
  | { applied: true; assigneeAgentId: string; reason: IssueAssigneeFallbackReason; degraded: false }
  /**
   * No rung was invokable, but the company has agents. We still assign -- fail visible,
   * never fail closed -- and flag the issue for the sweep.
   */
  | {
    applied: true;
    assigneeAgentId: string;
    reason: IssueAssigneeFallbackReason;
    degraded: true;
    degradedReason: IssueAssigneeDegradedReason;
    candidatesConsidered: string[];
  }
  /**
   * The company has zero agents, so no owner can be named. The caller does NOT reject:
   * it creates the issue unassigned and persists this flag. An unassigned issue in an
   * empty company is the correct record -- the work exists, it is queryable, and it gets
   * an owner the moment one exists. `applied: false` here means "flag," not "reject."
   */
  | { applied: false; reason: "no_agents_in_company"; degradedReason: "no_agents_in_company" };

export type IssueAssigneeFallbackInput = {
  companyId: string;
  /** Explicit agent assignee from the request, if any. */
  assigneeAgentId?: string | null;
  /** Explicit user assignee from the request, if any. A user assignee is a real owner. */
  assigneeUserId?: string | null;
  /** Assignee of the parent issue, when creating a child. */
  parentAssigneeAgentId?: string | null;
  /** The agent creating the issue, if the actor is an agent. */
  createdByAgentId?: string | null;
  /** Company agent roster, used to evaluate invokability and walk the org chain. */
  companyAgents: AgentOrgRow[];
};

const MAX_MANAGER_CHAIN_DEPTH = 32;

function isInvokable(agentId: string | null | undefined, companyAgents: AgentOrgRow[]): boolean {
  if (!agentId) return false;
  const agent = companyAgents.find((row) => row.id === agentId);
  if (!agent) return false;
  return evaluateAgentInvokability(agent, companyAgents).invokable;
}

/**
 * Walk `reportsTo` upward from `agentId` and return the first invokable manager.
 * Cycle-safe and depth-capped; returns null when the chain yields nothing wakeable.
 */
function findNearestInvokableManager(
  agentId: string,
  companyAgents: AgentOrgRow[],
): string | null {
  const byId = new Map(companyAgents.map((row) => [row.id, row]));
  const seen = new Set<string>([agentId]);
  let current = byId.get(agentId)?.reportsTo ?? null;
  let depth = 0;

  while (current && depth < MAX_MANAGER_CHAIN_DEPTH) {
    if (seen.has(current)) return null;
    seen.add(current);
    if (isInvokable(current, companyAgents)) return current;
    current = byId.get(current)?.reportsTo ?? null;
    depth += 1;
  }
  return null;
}

/**
 * The company root agent: the unique agent with no manager. When several exist (or the
 * roster is malformed) the ID sort keeps selection deterministic across calls.
 *
 * Returns both the invokable root (preferred) and a deterministic degraded root to fall
 * back onto. A paused root is still the company's owner of last resort, so it is a valid
 * degraded assignee even though it cannot be woken right now.
 */
function findCompanyRootAgents(companyAgents: AgentOrgRow[]): {
  invokable: string | null;
  any: string | null;
} {
  const roots = companyAgents
    .filter((row) => !row.reportsTo)
    .map((row) => row.id)
    .sort();
  return {
    invokable: roots.find((id) => isInvokable(id, companyAgents)) ?? null,
    any: roots[0] ?? null,
  };
}

/**
 * Deterministic owner of last resort when the company has agents but none are invokable
 * and there is no root row at all (malformed roster: every agent has a manager, i.e. the
 * `reportsTo` graph is entirely cyclic). Sorting by ID keeps this stable across calls.
 */
function findAnyAgent(companyAgents: AgentOrgRow[]): string | null {
  return companyAgents.map((row) => row.id).sort()[0] ?? null;
}

export function resolveIssueAssigneeFallback(
  input: IssueAssigneeFallbackInput,
): IssueAssigneeFallbackResult {
  const hasExplicitAgent = typeof input.assigneeAgentId === "string" && input.assigneeAgentId.length > 0;
  const hasExplicitUser = typeof input.assigneeUserId === "string" && input.assigneeUserId.length > 0;
  if (hasExplicitAgent || hasExplicitUser) {
    return { applied: false, reason: "explicit" };
  }

  const { companyAgents } = input;
  const candidatesConsidered: string[] = [];
  const roots = findCompanyRootAgents(companyAgents);

  const rungs: Array<{ reason: IssueAssigneeFallbackReason; agentId: string | null }> = [
    { reason: "parent", agentId: input.parentAssigneeAgentId ?? null },
    {
      reason: "creator_manager",
      agentId: input.createdByAgentId
        ? findNearestInvokableManager(input.createdByAgentId, companyAgents)
        : null,
    },
    { reason: "creator", agentId: input.createdByAgentId ?? null },
    { reason: "company_root", agentId: roots.invokable },
  ];

  for (const rung of rungs) {
    if (!rung.agentId) continue;
    candidatesConsidered.push(`${rung.reason}:${rung.agentId}`);
    if (isInvokable(rung.agentId, companyAgents)) {
      return { applied: true, assigneeAgentId: rung.agentId, reason: rung.reason, degraded: false };
    }
  }

  // Every rung missed. Fail visible, never fail closed: still name an owner so the issue
  // gets written, and flag it so the sweep can route it once the roster recovers. A paused
  // or terminated root is still the company's owner of last resort -- pausing is reversible,
  // and a flagged issue with a stale owner is strictly better than no issue at all.
  const degradedOwner = roots.any ?? findAnyAgent(companyAgents);
  if (degradedOwner) {
    return {
      applied: true,
      assigneeAgentId: degradedOwner,
      reason: "company_root",
      degraded: true,
      degradedReason: "no_invokable_owner",
      candidatesConsidered,
    };
  }

  // Zero agents in the company: no owner can be named. We do NOT reject -- creating the
  // issue unassigned and flagged is the correct record for an empty company. This is the
  // bootstrap state of every company, and someone has to be able to file the first issue.
  return { applied: false, reason: "no_agents_in_company", degradedReason: "no_agents_in_company" };
}

export async function loadCompanyAgentOrgRows(db: Db, companyId: string): Promise<AgentOrgRow[]> {
  return db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      reportsTo: agents.reportsTo,
      status: agents.status,
    })
    .from(agents)
    .where(eq(agents.companyId, companyId));
}

export async function resolveIssueAssigneeFallbackFromDb(
  db: Db,
  input: Omit<IssueAssigneeFallbackInput, "companyAgents">,
): Promise<IssueAssigneeFallbackResult> {
  const hasExplicitAgent = typeof input.assigneeAgentId === "string" && input.assigneeAgentId.length > 0;
  const hasExplicitUser = typeof input.assigneeUserId === "string" && input.assigneeUserId.length > 0;
  // Avoid the roster query entirely on the common explicit-assignee path.
  if (hasExplicitAgent || hasExplicitUser) {
    return { applied: false, reason: "explicit" };
  }
  const companyAgents = await loadCompanyAgentOrgRows(db, input.companyId);
  return resolveIssueAssigneeFallback({ ...input, companyAgents });
}
